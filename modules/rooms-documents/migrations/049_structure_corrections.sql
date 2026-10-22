-- Publication rebuilds the published snapshot without a removal in the same transaction
-- that trashes it, so whether trashed content was viewer-visible is recorded at trash time.
ALTER TABLE room_trash ADD COLUMN was_published boolean NOT NULL DEFAULT false;
-- Publication trashed earlier rows in the transaction that wrote its room.publish audit.
UPDATE room_trash t SET was_published=true FROM audit_event a
  WHERE a.event_type='room.publish' AND a.room_id=t.room_id AND a.occurred_at=t.trashed_at;

-- Only publication trashes a removal while the published snapshot still lists it or
-- content beneath it; a draft-only removal never has any (capture_draft_only_trash).
CREATE OR REPLACE FUNCTION place_entry_in_trash(p_entry_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE trash_id text; purge_job_id text; selected working_structure_entry%ROWTYPE;
BEGIN
  SELECT * INTO selected FROM working_structure_entry WHERE id=p_entry_id AND staged_removed;
  IF selected.id IS NULL OR EXISTS(SELECT 1 FROM room_trash WHERE root_entry_id=p_entry_id) THEN RETURN; END IF;
  trash_id := replace(gen_random_uuid()::text,'-','');
  purge_job_id := replace(gen_random_uuid()::text,'-','');
  INSERT INTO room_trash(id,room_id,root_entry_id,resource_kind,resource_id,purge_after,was_published)
  VALUES(trash_id,selected.room_id,selected.id,
    CASE WHEN selected.folder_id IS NOT NULL THEN 'folder' ELSE 'document' END,
    COALESCE(selected.folder_id,selected.document_id),transaction_timestamp()+interval '30 days',
    EXISTS(
      WITH RECURSIVE subtree AS (
        SELECT selected.id AS id,selected.folder_id AS folder_id
        UNION ALL SELECT child.id,child.folder_id FROM subtree parent
          JOIN working_structure_entry child ON child.parent_folder_id=parent.folder_id)
      SELECT 1 FROM subtree s JOIN published_structure_entry p
        ON p.room_id=selected.room_id AND p.entry_id=s.id));
  INSERT INTO job_queue(id,job_type,idempotency_key,payload,available_at,max_attempts)
  VALUES(purge_job_id,'room.trash.purge','trash-purge:'||trash_id,
    jsonb_build_object('trashId',trash_id),transaction_timestamp()+interval '30 days',10);
END $$;

CREATE OR REPLACE FUNCTION read_member_trash(p_actor_id text,p_room_id text)
RETURNS TABLE(trash_id text,resource_kind text,display_name text,root_entry_id text,
  entry_revision integer,trashed_at timestamptz,purge_after timestamptz,
  was_published boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT t.id,t.resource_kind,e.display_name,t.root_entry_id,e.revision,
    t.trashed_at,t.purge_after,t.was_published
  FROM room_trash t JOIN working_structure_entry e ON e.id=t.root_entry_id
  WHERE t.room_id=p_room_id AND member_can_mutate_room(p_actor_id,p_room_id,false)
  ORDER BY t.purge_after,t.id
$$;

-- Sibling names follow the room-title rule (022): a tab or line break is invisible in a
-- listing, so such a name would sit beside its lookalike past the sibling-name index.
-- Every structure writer sets display_name, so one trigger covers them all. Only a name
-- being changed is checked, so an entry named under the older rule still moves and leaves.
CREATE FUNCTION reject_invalid_structure_name() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN
  IF (TG_OP='INSERT' OR NEW.display_name IS DISTINCT FROM OLD.display_name)
     AND valid_room_title(NEW.display_name) IS NOT TRUE THEN
    RAISE EXCEPTION 'invalid structure name' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER working_entry_name_rule BEFORE INSERT OR UPDATE OF display_name
ON working_structure_entry FOR EACH ROW EXECUTE FUNCTION reject_invalid_structure_name();
REVOKE ALL ON FUNCTION reject_invalid_structure_name() FROM PUBLIC;
ALTER FUNCTION reject_invalid_structure_name() OWNER TO duefold_migration;

-- Runtime-callable since 004 with no caller.
DROP FUNCTION read_document_revision(text,text);
