-- Duefold trash, metadata search, guarded bulk operations, and purge boundary.

-- Fixed product constants: callers cannot supply or configure trash retention.
CREATE TABLE room_trash (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{32}$'),
  room_id text NOT NULL REFERENCES room(id),
  root_entry_id text NOT NULL UNIQUE,
  resource_kind text NOT NULL CHECK (resource_kind IN ('folder','document')),
  resource_id text NOT NULL,
  trashed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  purge_after timestamptz NOT NULL,
  CHECK (purge_after = trashed_at + interval '30 days')
);
CREATE INDEX room_trash_due ON room_trash(purge_after,id);
COMMENT ON TABLE room_trash IS 'Working-tree roots retained for exactly 30 days; former sibling names are not reserved.';
CREATE FUNCTION enforce_fixed_trash_retention() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='UPDATE' AND (NEW.trashed_at IS DISTINCT FROM OLD.trashed_at OR NEW.purge_after IS DISTINCT FROM OLD.purge_after) THEN
    RAISE EXCEPTION 'trash retention is fixed' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fixed_trash_retention BEFORE UPDATE OF trashed_at,purge_after ON room_trash
FOR EACH ROW EXECUTE FUNCTION enforce_fixed_trash_retention();

REVOKE ALL ON room_trash FROM PUBLIC,duefold_runtime,duefold_worker;
ALTER TABLE room_trash OWNER TO duefold_migration;

-- Search indexes cover metadata only. There is deliberately no version, OCR, source,
-- original filename, object-key, or text-layer index. One immutable canonical
-- normalizer feeds every index and every query arm, preventing punctuation drift.
CREATE FUNCTION canonical_search_text(value text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT normalize(
    trim(regexp_replace(lower(normalize(COALESCE(value,''),NFC)), E'[[:space:]()\\[\\]{}<>,.;:!?/\\\\|_+=*&#%@''"~-]+', ' ', 'g')),
    NFC
  )
$$;

-- Built-in GIN array indexing avoids a deployment-only extension dependency.
-- Every code-point 1-, 2-, and 3-gram is indexed; longer fallback queries use
-- their trigrams as an indexed prefilter and LIKE supplies exact substring truth.
CREATE FUNCTION search_text_grams(value text) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  WITH input AS (SELECT regexp_split_to_array(public.canonical_search_text(value),'') chars),
  grams AS (
    SELECT array_to_string(chars[i:LEAST(array_length(chars,1),i+n-1)],'') gram
    FROM input CROSS JOIN LATERAL generate_series(1,COALESCE(array_length(chars,1),0)) i
    CROSS JOIN generate_series(1,3) n
    WHERE i+n-1<=array_length(chars,1)
  ) SELECT COALESCE(array_agg(DISTINCT gram ORDER BY gram),'{}'::text[]) FROM grams
$$;

CREATE INDEX room_metadata_search ON room USING gin
  (to_tsvector('simple',public.canonical_search_text(title || ' ' || description)));
CREATE INDEX room_metadata_substring ON room USING gin
  (array_prepend('room:' || id, public.search_text_grams(title || ' ' || description)));
CREATE INDEX working_name_search ON working_structure_entry USING gin
  (to_tsvector('simple',public.canonical_search_text(display_name)));
CREATE INDEX working_name_substring ON working_structure_entry USING gin
  (array_prepend('room:' || room_id, public.search_text_grams(display_name)));
CREATE INDEX folder_description_search ON folder USING gin
  (to_tsvector('simple',public.canonical_search_text(description)));
CREATE INDEX folder_description_substring ON folder USING gin
  (array_prepend('room:' || room_id, public.search_text_grams(description)));
CREATE INDEX document_metadata_search ON document USING gin
  (to_tsvector('simple',public.canonical_search_text(display_title || ' ' || description)));
CREATE INDEX document_metadata_substring ON document USING gin
  (array_prepend('room:' || room_id, public.search_text_grams(display_title || ' ' || description)));
CREATE INDEX published_metadata_search ON published_structure_entry USING gin
  (to_tsvector('simple',public.canonical_search_text(display_name || ' ' || description)));
CREATE INDEX published_metadata_substring ON published_structure_entry USING gin
  (array_prepend('room:' || room_id, public.search_text_grams(display_name || ' ' || description)));

CREATE FUNCTION search_text_matches(value text, query_text text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN public.canonical_search_text(query_text)='' THEN false
    WHEN numnode(plainto_tsquery('simple',public.canonical_search_text(query_text)))>0
      THEN to_tsvector('simple',public.canonical_search_text(value))
        @@ plainto_tsquery('simple',public.canonical_search_text(query_text))
    ELSE public.search_text_grams(value) @> public.search_text_grams(query_text)
      AND public.canonical_search_text(value) LIKE '%' || public.canonical_search_text(query_text) || '%'
  END
$$;

CREATE FUNCTION zero_lexeme_member_search(
  p_room_id text,p_query text,p_limit integer
) RETURNS TABLE(resource_kind text,resource_id text,display_name text,description text,path text)
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  WITH RECURSIVE active AS (
      SELECT e.id,e.folder_id,e.document_id,e.parent_folder_id,e.display_name,e.order_key,
        e.display_name::text AS full_path
      FROM working_structure_entry e
      WHERE e.room_id=p_room_id AND e.parent_folder_id IS NULL AND NOT e.staged_removed
      UNION ALL
      SELECT child.id,child.folder_id,child.document_id,child.parent_folder_id,
        child.display_name,child.order_key,(parent.full_path || ' / ' || child.display_name)::text
      FROM active parent JOIN working_structure_entry child ON child.parent_folder_id=parent.folder_id
      WHERE child.room_id=p_room_id AND NOT child.staged_removed
    ), matched_entry_ids AS (
      SELECT e.id FROM working_structure_entry e
      WHERE array_prepend('room:' || e.room_id,public.search_text_grams(e.display_name))
          @> array_prepend('room:' || p_room_id,public.search_text_grams(p_query))
        AND public.canonical_search_text(e.display_name)
          LIKE '%' || public.canonical_search_text(p_query) || '%'
      UNION
      SELECT e.id FROM folder f JOIN working_structure_entry e ON e.folder_id=f.id
      WHERE NOT e.staged_removed
        AND array_prepend('room:' || f.room_id,public.search_text_grams(f.description))
          @> array_prepend('room:' || p_room_id,public.search_text_grams(p_query))
        AND public.canonical_search_text(f.description)
          LIKE '%' || public.canonical_search_text(p_query) || '%'
      UNION
      SELECT e.id FROM document d JOIN working_structure_entry e ON e.document_id=d.id
      WHERE NOT e.staged_removed
        AND array_prepend('room:' || d.room_id,
          public.search_text_grams(d.display_title || ' ' || d.description))
          @> array_prepend('room:' || p_room_id,public.search_text_grams(p_query))
        AND public.canonical_search_text(d.display_title || ' ' || d.description)
          LIKE '%' || public.canonical_search_text(p_query) || '%'
    ), candidates AS (
      SELECT 'room'::text kind,r.id rid,r.title name,r.description descr,
        r.title::text full_path,0::numeric sort_key
      FROM room r WHERE r.id=p_room_id
        AND array_prepend('room:' || r.id,public.search_text_grams(r.title || ' ' || r.description))
          @> array_prepend('room:' || p_room_id,public.search_text_grams(p_query))
        AND public.canonical_search_text(r.title || ' ' || r.description)
          LIKE '%' || public.canonical_search_text(p_query) || '%'
      UNION ALL
      SELECT CASE WHEN a.folder_id IS NOT NULL THEN 'folder' ELSE 'document' END,
        COALESCE(a.folder_id,a.document_id),a.display_name,
        CASE WHEN a.folder_id IS NOT NULL THEN f.description ELSE d.description END,
        a.full_path,a.order_key
      FROM active a JOIN matched_entry_ids m ON m.id=a.id
        LEFT JOIN folder f ON f.id=a.folder_id LEFT JOIN document d ON d.id=a.document_id
    )
    SELECT kind,rid,name,descr,full_path FROM candidates
    ORDER BY full_path,sort_key,rid LIMIT p_limit
$$;
REVOKE ALL ON FUNCTION zero_lexeme_member_search(text,text,integer) FROM PUBLIC,duefold_runtime,duefold_worker;

CREATE FUNCTION member_search_room(
  p_actor_id text,p_room_id text,p_query text,p_limit integer
) RETURNS TABLE(resource_kind text,resource_id text,display_name text,description text,path text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF length(p_query) NOT BETWEEN 1 AND 200 OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid search bounds' USING ERRCODE='22023';
  END IF;
  -- Authorization is resolved before any metadata matching, including fallback.
  IF NOT member_can_mutate_room(p_actor_id,p_room_id,false) OR NOT EXISTS(
    SELECT 1 FROM room WHERE id=p_room_id AND state<>'archived'
  ) THEN RETURN; END IF;
  IF numnode(plainto_tsquery('simple',public.canonical_search_text(p_query)))=0 THEN
    RETURN QUERY SELECT * FROM zero_lexeme_member_search(p_room_id,p_query,p_limit);
    RETURN;
  END IF;
  RETURN QUERY
  WITH RECURSIVE active AS (
    SELECT e.id,e.folder_id,e.document_id,e.parent_folder_id,e.display_name,e.order_key,
      e.display_name::text AS full_path
    FROM working_structure_entry e
    WHERE e.room_id=p_room_id AND e.parent_folder_id IS NULL AND NOT e.staged_removed
    UNION ALL
    SELECT child.id,child.folder_id,child.document_id,child.parent_folder_id,
      child.display_name,child.order_key,(parent.full_path || ' / ' || child.display_name)::text
    FROM active parent JOIN working_structure_entry child ON child.parent_folder_id=parent.folder_id
    WHERE child.room_id=p_room_id AND NOT child.staged_removed
  ), matched_entry_ids AS (
    -- Each full-text predicate is identical to one declared expression index.
    -- Zero-lexeme fallback is handled above by the room-scoped GIN arrays.
    SELECT e.id
    FROM working_structure_entry e
    WHERE e.room_id=p_room_id AND NOT e.staged_removed
      AND public.search_text_matches(e.display_name,p_query)
    UNION
    SELECT e.id
    FROM folder f JOIN working_structure_entry e ON e.folder_id=f.id
    WHERE f.room_id=p_room_id AND e.room_id=p_room_id AND NOT e.staged_removed
      AND public.search_text_matches(f.description,p_query)
    UNION
    SELECT e.id
    FROM document d JOIN working_structure_entry e ON e.document_id=d.id
    WHERE d.room_id=p_room_id AND e.room_id=p_room_id AND NOT e.staged_removed
      AND public.search_text_matches(d.display_title || ' ' || d.description,p_query)
  ), candidates AS (
    SELECT 'room'::text AS kind,r.id AS rid,r.title AS name,r.description AS descr,
      r.title::text AS full_path,0::numeric AS sort_key
    FROM room r WHERE r.id=p_room_id
      AND public.search_text_matches(r.title || ' ' || r.description,p_query)
    UNION ALL
    SELECT CASE WHEN a.folder_id IS NOT NULL THEN 'folder' ELSE 'document' END,
      COALESCE(a.folder_id,a.document_id),a.display_name,
      CASE WHEN a.folder_id IS NOT NULL THEN f.description ELSE d.description END,
      a.full_path,a.order_key
    FROM active a JOIN matched_entry_ids m ON m.id=a.id
      LEFT JOIN folder f ON f.id=a.folder_id LEFT JOIN document d ON d.id=a.document_id
  )
  SELECT kind,rid,name,descr,full_path FROM candidates
  ORDER BY full_path,sort_key,rid LIMIT p_limit;
END $$;


-- Insert a trash root and its delayed worker job. IDs are 122 random bits after
-- UUID hyphen removal and are never derived from names, paths, or object keys.
CREATE FUNCTION place_entry_in_trash(p_entry_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE trash_id text; purge_job_id text; selected working_structure_entry%ROWTYPE;
BEGIN
  SELECT * INTO selected FROM working_structure_entry WHERE id=p_entry_id AND staged_removed;
  IF selected.id IS NULL OR EXISTS(SELECT 1 FROM room_trash WHERE root_entry_id=p_entry_id) THEN RETURN; END IF;
  trash_id := replace(gen_random_uuid()::text,'-','');
  purge_job_id := replace(gen_random_uuid()::text,'-','');
  INSERT INTO room_trash(id,room_id,root_entry_id,resource_kind,resource_id,purge_after)
  VALUES(trash_id,selected.room_id,selected.id,
    CASE WHEN selected.folder_id IS NOT NULL THEN 'folder' ELSE 'document' END,
    COALESCE(selected.folder_id,selected.document_id),transaction_timestamp()+interval '30 days');
  INSERT INTO job_queue(id,job_type,idempotency_key,payload,available_at,max_attempts)
  VALUES(purge_job_id,'room.trash.purge','trash-purge:'||trash_id,
    jsonb_build_object('trashId',trash_id),transaction_timestamp()+interval '30 days',10);
END $$;

CREATE FUNCTION capture_draft_only_trash() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN
  IF NOT OLD.staged_removed AND NEW.staged_removed AND NOT EXISTS(
    SELECT 1 FROM published_structure_entry p WHERE p.room_id=NEW.room_id AND p.entry_id=NEW.id
  ) THEN PERFORM place_entry_in_trash(NEW.id); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER working_entry_draft_trash AFTER UPDATE OF staged_removed ON working_structure_entry
FOR EACH ROW EXECUTE FUNCTION capture_draft_only_trash();

CREATE FUNCTION restore_trash_entry(
  p_trash_id text,p_destination_folder_id text,p_display_name text,p_order_key numeric,
  p_actor_id text,p_expected_entry_revision integer,p_expected_working_revision integer,
  p_audit_id text,p_correlation_id text
) RETURNS TABLE(entry_revision integer,working_revision integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected room_trash%ROWTYPE; next_entry integer; next_working integer;
BEGIN
  SELECT * INTO selected FROM room_trash WHERE id=p_trash_id AND purge_after>transaction_timestamp() FOR UPDATE;
  -- Manager-only: trash restore is assigned to the Room Manager, and
  -- is among the powers a Contributor does NOT hold. Restore returns content
  -- to the working structure, so passing manager_only=false here let a Contributor
  -- reverse a Manager's removal decision.
  IF selected.id IS NULL OR NOT member_can_mutate_room(p_actor_id,selected.room_id,true) THEN
    RAISE EXCEPTION 'trash restore forbidden' USING ERRCODE='42501';
  END IF;
  -- Explicit destination is required: root is represented by NULL, not omission.
  IF p_destination_folder_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM working_structure_entry e WHERE e.folder_id=p_destination_folder_id
      AND e.room_id=selected.room_id AND NOT e.staged_removed
  ) THEN RAISE EXCEPTION 'restore destination unavailable' USING ERRCODE='23514'; END IF;
  UPDATE room SET working_revision=room.working_revision+1
    WHERE id=selected.room_id AND state<>'archived' AND room.working_revision=p_expected_working_revision
    RETURNING room.working_revision INTO next_working;
  IF next_working IS NULL THEN RAISE EXCEPTION 'stale room structure' USING ERRCODE='40001'; END IF;
  -- The existing unique sibling index rejects conflicts. There is deliberately no
  -- suffixing, replacement, or alternate-name branch.
  UPDATE working_structure_entry SET parent_folder_id=p_destination_folder_id,
      display_name=p_display_name,order_key=p_order_key,staged_removed=false,revision=revision+1
    WHERE id=selected.root_entry_id AND staged_removed AND revision=p_expected_entry_revision
    RETURNING revision INTO next_entry;
  IF next_entry IS NULL THEN RAISE EXCEPTION 'stale trash entry' USING ERRCODE='40001'; END IF;
  IF selected.resource_kind='document' THEN
    UPDATE document SET display_title=p_display_name,revision=revision+1 WHERE id=selected.resource_id;
  END IF;
  DELETE FROM room_trash WHERE id=p_trash_id;
  DELETE FROM job_queue
    WHERE job_type='room.trash.purge' AND payload->>'trashId'=p_trash_id AND state='pending';
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,
    result,reason_code,correlation_id,detail)
  VALUES(p_audit_id,'room.trash','member',p_actor_id,selected.room_id,selected.resource_kind,
    selected.resource_id,'success','TRASH_RESTORED',p_correlation_id,
    jsonb_build_object('workingRevision',next_working,'entryRevision',next_entry));
  RETURN QUERY SELECT next_entry,next_working;
END $$;

-- Dry-run and apply use whole-batch atomicity. A failed item raises and rolls back
-- every structure mutation and the audit insert; committed results are all success.
CREATE FUNCTION dry_run_bulk_move(
  p_actor_id text,p_room_id text,p_destination_folder_id text,p_items jsonb
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE item_count integer; impact jsonb;
BEGIN
  IF NOT member_can_mutate_room(p_actor_id,p_room_id,false) THEN
    RAISE EXCEPTION 'room contribution forbidden' USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(p_items)<>'array' THEN RAISE EXCEPTION 'invalid bulk items' USING ERRCODE='22023'; END IF;
  item_count:=jsonb_array_length(p_items);
  IF item_count NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'bulk item bound exceeded' USING ERRCODE='54000'; END IF;
  IF p_destination_folder_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM working_structure_entry WHERE room_id=p_room_id
      AND folder_id=p_destination_folder_id AND NOT staged_removed
  ) THEN RAISE EXCEPTION 'bulk destination unavailable' USING ERRCODE='23514'; END IF;
  IF EXISTS(
    SELECT 1 FROM jsonb_array_elements(p_items) x
    LEFT JOIN working_structure_entry e ON e.id=x->>'entryId' AND e.room_id=p_room_id AND NOT e.staged_removed
    WHERE e.id IS NULL OR x->>'entryId' !~ '^[A-Za-z0-9_-]{32}$'
      OR (x->>'expectedEntryRevision') !~ '^[1-9][0-9]*$'
      OR (x->>'orderKey') !~ '^[0-9]+([.][0-9]+)?$'
  ) THEN RAISE EXCEPTION 'invalid bulk item' USING ERRCODE='22023'; END IF;
  IF EXISTS(
    SELECT 1 FROM jsonb_array_elements(p_items) x JOIN working_structure_entry e ON e.id=x->>'entryId'
    WHERE e.revision<>(x->>'expectedEntryRevision')::integer
  ) THEN RAISE EXCEPTION 'stale bulk item' USING ERRCODE='40001'; END IF;
  IF (SELECT count(DISTINCT x->>'entryId') FROM jsonb_array_elements(p_items) x)<>item_count THEN
    RAISE EXCEPTION 'duplicate bulk item' USING ERRCODE='22023';
  END IF;
  IF EXISTS(
    SELECT 1 FROM jsonb_array_elements(p_items) x JOIN working_structure_entry moved ON moved.id=x->>'entryId'
    JOIN working_structure_entry occupied ON occupied.room_id=p_room_id
      AND occupied.parent_folder_id IS NOT DISTINCT FROM p_destination_folder_id
      AND occupied.normalized_name=moved.normalized_name AND NOT occupied.staged_removed
      AND NOT (occupied.id IN (SELECT y->>'entryId' FROM jsonb_array_elements(p_items) y))
  ) OR EXISTS(
    SELECT 1 FROM jsonb_array_elements(p_items) x JOIN working_structure_entry moved ON moved.id=x->>'entryId'
    GROUP BY moved.normalized_name HAVING count(*)>1
  ) OR EXISTS(
    SELECT 1 FROM jsonb_array_elements(p_items) x
    GROUP BY (x->>'orderKey')::numeric HAVING count(*)>1
  ) OR EXISTS(
    SELECT 1 FROM jsonb_array_elements(p_items) x JOIN working_structure_entry occupied
      ON occupied.room_id=p_room_id AND occupied.parent_folder_id IS NOT DISTINCT FROM p_destination_folder_id
      AND occupied.order_key=(x->>'orderKey')::numeric AND NOT occupied.staged_removed
      AND NOT (occupied.id IN (SELECT y->>'entryId' FROM jsonb_array_elements(p_items) y))
  ) THEN RAISE EXCEPTION 'bulk sibling collision' USING ERRCODE='23505'; END IF;
  -- A folder may not move beneath itself or any descendant.
  IF p_destination_folder_id IS NOT NULL AND EXISTS(
    WITH RECURSIVE ancestors(id) AS (
      SELECT p_destination_folder_id UNION ALL
      SELECT e.parent_folder_id FROM ancestors a JOIN working_structure_entry e ON e.folder_id=a.id
      WHERE e.parent_folder_id IS NOT NULL
    ) SELECT 1 FROM ancestors WHERE id IN(
      SELECT e.folder_id FROM jsonb_array_elements(p_items) x
      JOIN working_structure_entry e ON e.id=x->>'entryId' WHERE e.folder_id IS NOT NULL)
  ) THEN RAISE EXCEPTION 'folder cycle rejected' USING ERRCODE='23514'; END IF;
  SELECT jsonb_build_object('message','Move '||item_count||' item'||CASE WHEN item_count=1 THEN '' ELSE 's' END||
    ' to '||COALESCE((SELECT display_name FROM working_structure_entry WHERE folder_id=p_destination_folder_id),'room root')||'.',
    'affectedCount',item_count,'paths',jsonb_agg(e.display_name ORDER BY e.display_name),'confirmation','MOVE '||item_count||' ITEMS')
  INTO impact FROM jsonb_array_elements(p_items) x JOIN working_structure_entry e ON e.id=x->>'entryId';
  RETURN impact;
END $$;

CREATE FUNCTION apply_bulk_move(
  p_actor_id text,p_room_id text,p_destination_folder_id text,p_items jsonb,
  p_expected_working_revision integer,p_confirmation text,p_audit_id text,p_correlation_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE impact jsonb; next_working integer; changed integer; results jsonb;
BEGIN
  impact:=dry_run_bulk_move(p_actor_id,p_room_id,p_destination_folder_id,p_items);
  IF p_confirmation IS DISTINCT FROM impact->>'confirmation' THEN
    RAISE EXCEPTION 'typed confirmation mismatch' USING ERRCODE='22023';
  END IF;
  UPDATE room SET working_revision=working_revision+1
    WHERE id=p_room_id AND state<>'archived' AND working_revision=p_expected_working_revision
    RETURNING working_revision INTO next_working;
  IF next_working IS NULL THEN RAISE EXCEPTION 'stale room structure' USING ERRCODE='40001'; END IF;
  WITH parsed AS (
    SELECT x->>'entryId' id,(x->>'expectedEntryRevision')::integer expected_revision,
      (x->>'orderKey')::numeric order_key FROM jsonb_array_elements(p_items) x
  )
  UPDATE working_structure_entry e SET parent_folder_id=p_destination_folder_id,
    order_key=p.order_key,revision=e.revision+1 FROM parsed p
  WHERE e.id=p.id AND e.room_id=p_room_id AND e.revision=p.expected_revision AND NOT e.staged_removed;
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>jsonb_array_length(p_items) THEN RAISE EXCEPTION 'stale bulk item' USING ERRCODE='40001'; END IF;
  SELECT jsonb_agg(jsonb_build_object('entryId',x->>'entryId','status','moved') ORDER BY x->>'entryId')
    INTO results FROM jsonb_array_elements(p_items) x;
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,
    result,reason_code,correlation_id,detail)
  VALUES(p_audit_id,'room.bulk','member',p_actor_id,p_room_id,'room',p_room_id,'success',
    'BULK_MOVE_APPLIED',p_correlation_id,jsonb_build_object('count',changed,'workingRevision',next_working));
  RETURN jsonb_build_object('workingRevision',next_working,'items',results);
END $$;

-- This is the single definition of the snapshot apply will publish and dry-run
-- will compare. Adding a viewer-visible field requires changing this one contract,
-- so preview and apply cannot drift onto different projections.
CREATE FUNCTION proposed_publication_snapshot(p_room_id text)
RETURNS TABLE(room_id text,entry_id text,resource_kind text,resource_id text,
  parent_folder_id text,display_name text,description text,order_key numeric,
  source_revision integer,published_version_id text,path text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH RECURSIVE included AS (
    SELECT e.*,e.display_name::text AS full_path
    FROM working_structure_entry e
    WHERE e.room_id=p_room_id AND e.parent_folder_id IS NULL AND NOT e.staged_removed
    UNION ALL
    SELECT child.*,(parent.full_path || ' / ' || child.display_name)::text
    FROM included parent JOIN working_structure_entry child
      ON child.parent_folder_id=parent.folder_id
    WHERE child.room_id=p_room_id AND NOT child.staged_removed
  )
  SELECT e.room_id,e.id,
    CASE WHEN e.folder_id IS NOT NULL THEN 'folder' ELSE 'document' END,
    COALESCE(e.folder_id,e.document_id),e.parent_folder_id,e.display_name,
    CASE WHEN e.folder_id IS NOT NULL THEN f.description ELSE d.description END,
    e.order_key,e.revision,d.working_version_id,e.full_path
  FROM included e LEFT JOIN folder f ON f.id=e.folder_id LEFT JOIN document d ON d.id=e.document_id
  WHERE e.folder_id IS NOT NULL OR (d.working_version_id IS NOT NULL
    AND version_has_publication_evidence(d.working_version_id,d.id))
$$;

CREATE FUNCTION dry_run_bulk_publish(p_actor_id text,p_room_id text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE impact jsonb;
BEGIN
  IF NOT member_can_mutate_room(p_actor_id,p_room_id,true) THEN
    RAISE EXCEPTION 'room management forbidden' USING ERRCODE='42501';
  END IF;
  IF EXISTS(
    WITH RECURSIVE included AS (
      SELECT e.* FROM working_structure_entry e WHERE e.room_id=p_room_id AND e.parent_folder_id IS NULL AND NOT e.staged_removed
      UNION ALL SELECT child.* FROM included parent JOIN working_structure_entry child ON child.parent_folder_id=parent.folder_id
        WHERE child.room_id=p_room_id AND NOT child.staged_removed)
    SELECT 1 FROM included e JOIN document d ON d.id=e.document_id
    WHERE d.working_version_id IS NOT NULL AND NOT version_has_publication_evidence(d.working_version_id,d.id)
  ) THEN RAISE EXCEPTION 'document version lacks publication evidence' USING ERRCODE='23514'; END IF;
  WITH RECURSIVE old_paths AS (
    SELECT p.*,p.display_name::text AS full_path
    FROM published_structure_entry p WHERE p.room_id=p_room_id AND p.parent_folder_id IS NULL
    UNION ALL
    SELECT child.*,(parent.full_path || ' / ' || child.display_name)::text
    FROM old_paths parent JOIN published_structure_entry child
      ON child.room_id=p_room_id AND child.parent_folder_id=parent.resource_id
  ), compared AS (
    SELECT COALESCE(n.entry_id,o.entry_id) entry_id,COALESCE(n.path,o.full_path) path,
      array_remove(ARRAY[
        CASE WHEN o.entry_id IS NULL THEN 'add' END,
        CASE WHEN n.entry_id IS NULL THEN 'remove' END,
        CASE WHEN n.entry_id IS NOT NULL AND o.entry_id IS NOT NULL AND n.display_name IS DISTINCT FROM o.display_name THEN 'rename' END,
        CASE WHEN n.entry_id IS NOT NULL AND o.entry_id IS NOT NULL AND n.parent_folder_id IS DISTINCT FROM o.parent_folder_id THEN 'move' END,
        CASE WHEN n.entry_id IS NOT NULL AND o.entry_id IS NOT NULL AND n.order_key IS DISTINCT FROM o.order_key THEN 'reorder' END,
        CASE WHEN n.entry_id IS NOT NULL AND o.entry_id IS NOT NULL AND n.description IS DISTINCT FROM o.description THEN 'description' END,
        CASE WHEN n.entry_id IS NOT NULL AND o.entry_id IS NOT NULL AND n.published_version_id IS DISTINCT FROM o.published_version_id THEN 'version' END,
        CASE WHEN n.entry_id IS NOT NULL AND o.entry_id IS NOT NULL AND (n.resource_kind IS DISTINCT FROM o.resource_kind OR n.resource_id IS DISTINCT FROM o.resource_id) THEN 'replace' END
      ],NULL)::text[] changes
    FROM proposed_publication_snapshot(p_room_id) n FULL JOIN old_paths o ON o.entry_id=n.entry_id
  ), affected AS (SELECT * FROM compared WHERE cardinality(changes)>0), summary AS (
    SELECT count(*)::integer affected_count,
      COALESCE(jsonb_agg(path ORDER BY path),'[]'::jsonb) paths,
      COALESCE(jsonb_agg(jsonb_build_object('entryId',entry_id,'path',path,'changes',changes) ORDER BY path),'[]'::jsonb) items
    FROM affected
  )
  SELECT jsonb_build_object(
    'message','Publish '||affected_count||' structure change'||CASE WHEN affected_count=1 THEN '' ELSE 's' END||'.',
    'affectedCount',affected_count,'paths',paths,'items',items,
    'confirmation','PUBLISH '||affected_count||' CHANGES') INTO impact FROM summary;
  RETURN impact;
END $$;

CREATE FUNCTION apply_bulk_publish(
  p_actor_id text,p_room_id text,p_expected_working_revision integer,p_expected_published_revision integer,
  p_authenticated_at timestamptz,p_confirmation text,p_audit_id text,p_correlation_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE impact jsonb; next_published integer; results jsonb;
BEGIN
  IF p_authenticated_at IS NULL OR p_authenticated_at>transaction_timestamp()
    OR p_authenticated_at<transaction_timestamp()-interval '15 minutes' THEN
    RAISE EXCEPTION 'fresh OIDC required' USING ERRCODE='42501';
  END IF;
  impact:=dry_run_bulk_publish(p_actor_id,p_room_id);
  IF p_confirmation IS DISTINCT FROM impact->>'confirmation' THEN
    RAISE EXCEPTION 'typed confirmation mismatch' USING ERRCODE='22023';
  END IF;
  next_published:=publish_room_structure(p_room_id,p_actor_id,p_expected_working_revision,
    p_expected_published_revision,p_audit_id,p_correlation_id);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('entryId',entry_id,'status','published') ORDER BY entry_id),'[]'::jsonb)
    INTO results FROM published_structure_entry WHERE room_id=p_room_id;
  RETURN jsonb_build_object('publishedRevision',next_published,'items',results);
END $$;

-- The publication transaction first captures roots that were viewer-visible and
-- are now staged for removal. Draft-only roots were captured immediately by the
-- working-entry trigger. The snapshot switch and trash insertion remain atomic.
CREATE OR REPLACE FUNCTION publish_room_structure(
  p_room_id text,p_actor_id text,p_expected_working_revision integer,p_expected_published_revision integer,p_audit_id text,p_correlation_id text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE next_published integer; published_count integer; removed record;
BEGIN
  IF NOT member_can_mutate_room(p_actor_id,p_room_id,true) THEN RAISE EXCEPTION 'room management forbidden' USING ERRCODE='42501'; END IF;
  IF EXISTS(
    WITH RECURSIVE included AS (
      SELECT e.* FROM working_structure_entry e WHERE e.room_id=p_room_id AND e.parent_folder_id IS NULL AND NOT e.staged_removed
      UNION ALL SELECT child.* FROM included parent JOIN working_structure_entry child ON child.parent_folder_id=parent.folder_id
        WHERE child.room_id=p_room_id AND NOT child.staged_removed)
    SELECT 1 FROM included e JOIN document d ON d.id=e.document_id WHERE d.working_version_id IS NOT NULL
      AND NOT version_has_publication_evidence(d.working_version_id,d.id)
  ) THEN RAISE EXCEPTION 'document version lacks publication evidence' USING ERRCODE='23514'; END IF;
  UPDATE room SET published_revision=published_revision+1,published_at=transaction_timestamp(),revision=revision+1
    WHERE id=p_room_id AND state<>'archived' AND working_revision=p_expected_working_revision
      AND published_revision=p_expected_published_revision RETURNING published_revision INTO next_published;
  IF next_published IS NULL THEN RAISE EXCEPTION 'stale publication' USING ERRCODE='40001'; END IF;
  FOR removed IN SELECT e.id FROM working_structure_entry e JOIN published_structure_entry p
    ON p.room_id=e.room_id AND p.entry_id=e.id WHERE e.room_id=p_room_id AND e.staged_removed
  LOOP PERFORM place_entry_in_trash(removed.id); END LOOP;
  DELETE FROM published_structure_entry WHERE room_id=p_room_id;
  INSERT INTO published_structure_entry(room_id,entry_id,resource_kind,resource_id,parent_folder_id,display_name,description,order_key,source_revision,published_version_id)
  SELECT room_id,entry_id,resource_kind,resource_id,parent_folder_id,display_name,description,
    order_key,source_revision,published_version_id
  FROM proposed_publication_snapshot(p_room_id);
  GET DIAGNOSTICS published_count=ROW_COUNT;
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,result,reason_code,correlation_id,detail)
  VALUES(p_audit_id,'room.publish','member',p_actor_id,p_room_id,'room',p_room_id,'success','STRUCTURE_PUBLISHED',p_correlation_id,
    jsonb_build_object('workingRevision',p_expected_working_revision,'publishedRevision',next_published,'entryCount',published_count,
      'versionIds',(SELECT COALESCE(jsonb_agg(published_version_id ORDER BY published_version_id),'[]'::jsonb)
        FROM published_structure_entry WHERE room_id=p_room_id AND published_version_id IS NOT NULL)));
  RETURN next_published;
END $$;

-- Read-only lease validation and object manifest. Storage deletion happens after
-- this call and is idempotent; no database mutation precedes object deletion.
CREATE FUNCTION begin_trash_purge(p_trash_id text,p_job_id text,p_lease_owner text,p_lease_token text)
RETURNS TABLE(object_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM room_trash t JOIN job_queue j ON j.id=p_job_id
    WHERE t.id=p_trash_id AND t.purge_after<=transaction_timestamp()
      AND j.job_type='room.trash.purge' AND j.payload->>'trashId'=t.id
      AND j.state='running' AND j.lease_owner=p_lease_owner AND j.lease_token=p_lease_token
      AND j.lease_expires_at>transaction_timestamp()) THEN
    RAISE EXCEPTION 'trash purge lease lost or retention active' USING ERRCODE='55000';
  END IF;
  RETURN QUERY
  WITH RECURSIVE entries AS (
    SELECT e.* FROM room_trash t JOIN working_structure_entry e ON e.id=t.root_entry_id WHERE t.id=p_trash_id
    UNION ALL SELECT child.* FROM entries parent JOIN working_structure_entry child ON child.parent_folder_id=parent.folder_id
  ), versions AS (SELECT v.* FROM entries e JOIN document_version v ON v.document_id=e.document_id)
  SELECT v.object_key FROM versions v
  UNION SELECT d.object_key FROM versions v JOIN document_derivative d ON d.version_id=v.id
  UNION SELECT c.object_key FROM versions v JOIN derivative_cleanup_intent c ON c.version_id=v.id
  UNION SELECT o.object_key FROM versions v JOIN verified_derivative_object o ON o.version_id=v.id;
END $$;

-- Processing evidence is immutable to application and worker roles. Purge is a
-- narrowly leased SECURITY DEFINER path owned by duefold_migration.
CREATE OR REPLACE FUNCTION reject_processing_evidence_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF current_user<>'duefold_migration' THEN
    RAISE EXCEPTION 'processing evidence is immutable' USING ERRCODE='55000';
  END IF;
  RETURN COALESCE(NEW,OLD);
END $$;

CREATE FUNCTION finalize_trash_purge(
  p_trash_id text,p_job_id text,p_lease_owner text,p_lease_token text,p_audit_id text,p_correlation_id text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected_room text; document_ids text[]; folder_ids text[]; version_ids text[]; affected integer;
BEGIN
  SELECT t.room_id INTO selected_room
  FROM room_trash t JOIN job_queue j ON j.id=p_job_id
  WHERE t.id=p_trash_id AND t.purge_after<=transaction_timestamp()
    AND j.job_type='room.trash.purge' AND j.payload->>'trashId'=t.id
    AND j.state='running' AND j.lease_owner=p_lease_owner AND j.lease_token=p_lease_token
    AND j.lease_expires_at>transaction_timestamp() FOR UPDATE OF t,j;
  IF selected_room IS NULL THEN RAISE EXCEPTION 'trash purge lease lost or retention active' USING ERRCODE='55000'; END IF;
  WITH RECURSIVE entries AS (
    SELECT e.* FROM room_trash t JOIN working_structure_entry e ON e.id=t.root_entry_id WHERE t.id=p_trash_id
    UNION ALL SELECT child.* FROM entries parent JOIN working_structure_entry child ON child.parent_folder_id=parent.folder_id)
  SELECT COALESCE(array_agg(document_id) FILTER(WHERE document_id IS NOT NULL),'{}'),
    COALESCE(array_agg(folder_id) FILTER(WHERE folder_id IS NOT NULL),'{}') INTO document_ids,folder_ids FROM entries;
  SELECT COALESCE(array_agg(id),'{}') INTO version_ids FROM document_version WHERE document_id=ANY(document_ids);

  DELETE FROM verified_derivative_object x WHERE x.version_id=ANY(version_ids)
    AND EXISTS(SELECT 1 FROM job_queue j WHERE j.id=p_job_id AND j.state='running' AND j.lease_owner=p_lease_owner AND j.lease_token=p_lease_token AND j.lease_expires_at>transaction_timestamp());
  DELETE FROM derivative_cleanup_intent x WHERE x.version_id=ANY(version_ids)
    AND EXISTS(SELECT 1 FROM job_queue j WHERE j.id=p_job_id AND j.state='running' AND j.lease_owner=p_lease_owner AND j.lease_token=p_lease_token AND j.lease_expires_at>transaction_timestamp());
  DELETE FROM document_derivative x WHERE x.version_id=ANY(version_ids)
    AND EXISTS(SELECT 1 FROM job_queue j WHERE j.id=p_job_id AND j.state='running' AND j.lease_owner=p_lease_owner AND j.lease_token=p_lease_token AND j.lease_expires_at>transaction_timestamp());
  DELETE FROM document_scan_evidence x WHERE x.version_id=ANY(version_ids)
    AND EXISTS(SELECT 1 FROM job_queue j WHERE j.id=p_job_id AND j.state='running' AND j.lease_owner=p_lease_owner AND j.lease_token=p_lease_token AND j.lease_expires_at>transaction_timestamp());
  DELETE FROM scanner_observation x WHERE x.version_id=ANY(version_ids)
    AND EXISTS(SELECT 1 FROM job_queue j WHERE j.id=p_job_id AND j.state='running' AND j.lease_owner=p_lease_owner AND j.lease_token=p_lease_token AND j.lease_expires_at>transaction_timestamp());
  UPDATE document x SET working_version_id=NULL WHERE x.id=ANY(document_ids)
    AND EXISTS(SELECT 1 FROM job_queue j WHERE j.id=p_job_id AND j.state='running' AND j.lease_owner=p_lease_owner AND j.lease_token=p_lease_token AND j.lease_expires_at>transaction_timestamp());
  DELETE FROM upload_intent x WHERE x.document_id=ANY(document_ids)
    AND EXISTS(SELECT 1 FROM job_queue j WHERE j.id=p_job_id AND j.state='running' AND j.lease_owner=p_lease_owner AND j.lease_token=p_lease_token AND j.lease_expires_at>transaction_timestamp());
  DELETE FROM document_version x WHERE x.id=ANY(version_ids)
    AND EXISTS(SELECT 1 FROM job_queue j WHERE j.id=p_job_id AND j.state='running' AND j.lease_owner=p_lease_owner AND j.lease_token=p_lease_token AND j.lease_expires_at>transaction_timestamp());
  DELETE FROM working_structure_entry x WHERE (x.document_id=ANY(document_ids) OR x.folder_id=ANY(folder_ids))
    AND EXISTS(SELECT 1 FROM job_queue j WHERE j.id=p_job_id AND j.state='running' AND j.lease_owner=p_lease_owner AND j.lease_token=p_lease_token AND j.lease_expires_at>transaction_timestamp());
  DELETE FROM document x WHERE x.id=ANY(document_ids)
    AND EXISTS(SELECT 1 FROM job_queue j WHERE j.id=p_job_id AND j.state='running' AND j.lease_owner=p_lease_owner AND j.lease_token=p_lease_token AND j.lease_expires_at>transaction_timestamp());
  DELETE FROM folder x WHERE x.id=ANY(folder_ids)
    AND EXISTS(SELECT 1 FROM job_queue j WHERE j.id=p_job_id AND j.state='running' AND j.lease_owner=p_lease_owner AND j.lease_token=p_lease_token AND j.lease_expires_at>transaction_timestamp());
  DELETE FROM room_trash t WHERE t.id=p_trash_id
    AND EXISTS(SELECT 1 FROM job_queue j WHERE j.id=p_job_id AND j.state='running' AND j.lease_owner=p_lease_owner AND j.lease_token=p_lease_token AND j.lease_expires_at>transaction_timestamp());
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected<>1 THEN RAISE EXCEPTION 'trash purge lease lost' USING ERRCODE='55000'; END IF;
  -- Retained audit uses only now-orphaned opaque identifiers. No title,
  -- description, filename, path, object key, hash, email, or content survives.
  INSERT INTO audit_event(id,event_type,actor_kind,room_id,resource_type,result,reason_code,correlation_id,detail)
  SELECT p_audit_id,'room.trash','system',selected_room,'trash','success','TRASH_PURGED',p_correlation_id,
    jsonb_build_object('retentionDays',30) FROM job_queue j WHERE j.id=p_job_id AND j.state='running'
      AND j.lease_owner=p_lease_owner AND j.lease_token=p_lease_token AND j.lease_expires_at>transaction_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'trash purge lease lost' USING ERRCODE='55000'; END IF;
END $$;

REVOKE ALL ON FUNCTION canonical_search_text(text),public.search_text_grams(text),public.search_text_matches(text,text),proposed_publication_snapshot(text),
 member_search_room(text,text,text,integer),restore_trash_entry(text,text,text,numeric,text,integer,integer,text,text),
 dry_run_bulk_move(text,text,text,jsonb),apply_bulk_move(text,text,text,jsonb,integer,text,text,text),
 dry_run_bulk_publish(text,text),apply_bulk_publish(text,text,integer,integer,timestamptz,text,text,text),
 begin_trash_purge(text,text,text,text),finalize_trash_purge(text,text,text,text,text,text),
 place_entry_in_trash(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION canonical_search_text(text),search_text_grams(text),
 member_search_room(text,text,text,integer),
 restore_trash_entry(text,text,text,numeric,text,integer,integer,text,text),dry_run_bulk_move(text,text,text,jsonb),
 apply_bulk_move(text,text,text,jsonb,integer,text,text,text),dry_run_bulk_publish(text,text),
 apply_bulk_publish(text,text,integer,integer,timestamptz,text,text,text) TO duefold_runtime;
GRANT EXECUTE ON FUNCTION begin_trash_purge(text,text,text,text),
 finalize_trash_purge(text,text,text,text,text,text) TO duefold_worker;
-- The unguarded direct publication primitive is now internal-only. A
-- runtime caller must pass dry-run, typed-confirmation, fresh-OIDC and revision
-- gates through apply_bulk_publish; otherwise those controls are bypassable.
REVOKE EXECUTE ON FUNCTION publish_room_structure(text,text,integer,integer,text,text)
  FROM duefold_runtime;

ALTER FUNCTION canonical_search_text(text) OWNER TO duefold_migration;
ALTER FUNCTION search_text_grams(text) OWNER TO duefold_migration;
ALTER FUNCTION search_text_matches(text,text) OWNER TO duefold_migration;
ALTER FUNCTION proposed_publication_snapshot(text) OWNER TO duefold_migration;
ALTER FUNCTION zero_lexeme_member_search(text,text,integer) OWNER TO duefold_migration;
ALTER FUNCTION member_search_room(text,text,text,integer) OWNER TO duefold_migration;
ALTER FUNCTION enforce_fixed_trash_retention() OWNER TO duefold_migration;
ALTER FUNCTION place_entry_in_trash(text) OWNER TO duefold_migration;
ALTER FUNCTION capture_draft_only_trash() OWNER TO duefold_migration;
ALTER FUNCTION restore_trash_entry(text,text,text,numeric,text,integer,integer,text,text) OWNER TO duefold_migration;
ALTER FUNCTION dry_run_bulk_move(text,text,text,jsonb) OWNER TO duefold_migration;
ALTER FUNCTION apply_bulk_move(text,text,text,jsonb,integer,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION dry_run_bulk_publish(text,text) OWNER TO duefold_migration;
ALTER FUNCTION apply_bulk_publish(text,text,integer,integer,timestamptz,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION begin_trash_purge(text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION finalize_trash_purge(text,text,text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION reject_processing_evidence_mutation() OWNER TO duefold_migration;
