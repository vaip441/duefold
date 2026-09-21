-- Duefold room administration: room text rules, one-room reads, purge safety, and the
-- document revision structure writers compare. Immutable after application.

-- Room title validation: 1-200 code points of single-line visible text in NFC form.
-- NFKC normalization folds whitespace variants (such as non-breaking, em, and ideographic
-- spaces) to ASCII space so visually blank titles are rejected while internal spaces survive.
-- The regular expression rejects line and paragraph separators not folded by NFKC.
CREATE FUNCTION valid_room_title(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT valid_structure_text(value,200,false)
    AND btrim(normalize(value,NFKC)) <> ''
    AND value !~ '[\u0009\u000A\u000D\u0085\u2028\u2029]'
$$;

REVOKE ALL ON FUNCTION valid_room_title(text) FROM PUBLIC;
ALTER FUNCTION valid_room_title(text) OWNER TO duefold_migration;

-- create_room is the single authority on room text, so an unusable title is a 22023
-- the web process maps to 400.
CREATE OR REPLACE FUNCTION create_room(
  p_id text,p_title text,p_description text,p_actor_id text,p_audit_id text,p_correlation_id text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM member WHERE id=p_actor_id AND state='active'
                AND global_role IN ('owner','admin')) THEN
    RAISE EXCEPTION 'room creation forbidden' USING ERRCODE='42501';
  END IF;
  IF valid_room_title(p_title) IS NOT TRUE
     OR valid_structure_text(p_description,4000,true) IS NOT TRUE THEN
    RAISE EXCEPTION 'invalid room text' USING ERRCODE='22023';
  END IF;
  INSERT INTO room(id,title,description) VALUES(p_id,p_title,p_description);
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,
                          result,reason_code,correlation_id)
  VALUES(p_audit_id,'room.create','member',p_actor_id,p_id,'room',p_id,'success','ROOM_CREATED',
         p_correlation_id);
END $$;

-- One register row by id, with the columns and provenance rule of read_member_rooms, so an
-- open room never depends on which register page is loaded. Unreachable and unknown rooms
-- both return no row.
CREATE FUNCTION read_member_room(p_actor_id text,p_room_id text)
RETURNS TABLE(room_id text,title text,description text,state text,revision integer,
              working_revision integer,published_revision integer,room_role text,
              access_source text,can_publish boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT r.id,r.title,r.description,r.state,r.revision,r.working_revision,r.published_revision,
         a.room_role,
         CASE WHEN a.room_role IS NOT NULL THEN 'assignment' ELSE 'global_role' END,
         member_can_mutate_room(p_actor_id,r.id,true)
    FROM room r
    LEFT JOIN room_assignment a
      ON a.room_id=r.id AND a.member_id=p_actor_id AND a.state='active'
   WHERE r.id=p_room_id AND member_can_mutate_room(p_actor_id,r.id,false)
$$;

REVOKE ALL ON FUNCTION read_member_room(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_member_room(text,text) TO duefold_runtime;
ALTER FUNCTION read_member_room(text,text) OWNER TO duefold_migration;

-- A live purge pins its room to archived. Returning the room to service requires
-- cancelling the purge first; otherwise the job deletes a room that is back in use.
--
-- The states are listed rather than written as "not cancelled" because cancellation is the
-- only release and `cancel_room_purge` releases only a scheduled purge. Pinning on a state
-- cancellation cannot reach would strand the room in archived with no way out.
CREATE FUNCTION enforce_live_purge_pins_archive() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF OLD.state='archived' AND NEW.state<>'archived' AND EXISTS(
       SELECT 1 FROM room_purge p
        WHERE p.room_id=NEW.id AND p.state IN ('scheduled','marker_pending','purging')) THEN
    RAISE EXCEPTION 'room is pinned by a live purge' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER live_purge_pins_archive BEFORE UPDATE OF state ON room
FOR EACH ROW EXECUTE FUNCTION enforce_live_purge_pins_archive();
REVOKE ALL ON FUNCTION enforce_live_purge_pins_archive() FROM PUBLIC;
ALTER FUNCTION enforce_live_purge_pins_archive() OWNER TO duefold_migration;

-- A cancelled purge no longer holds its room.
ALTER TABLE room_purge DROP CONSTRAINT room_purge_room_id_key;
CREATE UNIQUE INDEX one_uncancelled_room_purge ON room_purge(room_id) WHERE state<>'cancelled';

-- The room is bound by id and expected revision, so the phrase is a constant a person can
-- type. A room that already holds a purge is refused here, before the unique index would.
CREATE OR REPLACE FUNCTION dry_run_room_purge(p_actor_id text,p_room_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE impact jsonb;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM member WHERE id=p_actor_id AND state='active' AND global_role='owner') THEN
    RAISE EXCEPTION 'owner required' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM room WHERE id=p_room_id AND state='archived') THEN
    RAISE EXCEPTION 'room must be archived' USING ERRCODE='55000';
  END IF;
  IF EXISTS(SELECT 1 FROM room_purge WHERE room_id=p_room_id AND state<>'cancelled') THEN
    RAISE EXCEPTION 'room already holds a purge' USING ERRCODE='55000';
  END IF;
  SELECT jsonb_build_object('roomId',p_room_id,
    'documentCount',(SELECT count(*) FROM document WHERE room_id=p_room_id),
    'viewerCount',(SELECT count(*) FROM viewer_room_membership WHERE room_id=p_room_id),
    'sourceBytes',(SELECT COALESCE(sum(v.size_bytes),0) FROM document d
                     JOIN document_version v ON v.document_id=d.id WHERE d.room_id=p_room_id),
    'cancellationDays',30,'confirmation','SCHEDULE ROOM PURGE') INTO impact;
  RETURN impact;
END $$;

-- The structure reader returns the revision document writers compare. The entry revision
-- and the document revision are distinct counters and a download override moves only the
-- second.
DROP FUNCTION read_member_working_structure(text,text);
CREATE FUNCTION read_member_working_structure(p_actor_id text,p_room_id text)
RETURNS TABLE(entry_id text,resource_kind text,resource_id text,parent_folder_id text,
  display_name text,description text,revision integer,document_revision integer,
  staged_removed boolean,depth integer,sibling_position integer,can_move_up boolean,
  can_move_down boolean,change_kinds text[],has_publishable_version boolean,is_published boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH RECURSIVE authorized AS (
    SELECT member_can_mutate_room(p_actor_id,p_room_id,false) allowed
  ), tree AS (
    SELECT e.*,0 AS depth FROM working_structure_entry e
    WHERE e.room_id=p_room_id AND e.parent_folder_id IS NULL
      AND (SELECT allowed FROM authorized)
    UNION ALL
    SELECT child.*,parent.depth+1 FROM tree parent JOIN working_structure_entry child
      ON child.parent_folder_id=parent.folder_id
    WHERE child.room_id=p_room_id AND parent.depth<5
  ), ordered AS (
    SELECT t.*,
      CASE WHEN t.staged_removed THEN NULL ELSE row_number() OVER (
        PARTITION BY t.parent_folder_id,t.staged_removed ORDER BY t.order_key,t.id
      )::integer END sibling_position,
      count(*) FILTER (WHERE NOT t.staged_removed) OVER (
        PARTITION BY t.parent_folder_id
      )::integer sibling_count
    FROM tree t
  )
  SELECT o.id,
    CASE WHEN o.folder_id IS NOT NULL THEN 'folder' ELSE 'document' END,
    COALESCE(o.folder_id,o.document_id),o.parent_folder_id,o.display_name,
    CASE WHEN o.folder_id IS NOT NULL THEN f.description ELSE d.description END,
    o.revision,d.revision,o.staged_removed,o.depth,o.sibling_position,
    COALESCE(o.sibling_position>1,false),
    COALESCE(o.sibling_position<o.sibling_count,false),
    COALESCE(c.changes,ARRAY[]::text[]),
    o.folder_id IS NOT NULL OR (d.working_version_id IS NOT NULL
      AND version_has_publication_evidence(d.working_version_id,d.id)),
    EXISTS(SELECT 1 FROM published_structure_entry p
      WHERE p.room_id=p_room_id AND p.entry_id=o.id)
  FROM ordered o
  LEFT JOIN folder f ON f.id=o.folder_id
  LEFT JOIN document d ON d.id=o.document_id
  LEFT JOIN publication_change_set(p_room_id) c ON c.entry_id=o.id
  ORDER BY o.depth,o.parent_folder_id NULLS FIRST,o.sibling_position,o.id
$$;
REVOKE ALL ON FUNCTION read_member_working_structure(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_member_working_structure(text,text) TO duefold_runtime;
ALTER FUNCTION read_member_working_structure(text,text) OWNER TO duefold_migration;
