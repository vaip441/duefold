-- Duefold room lifecycle and atomic published-structure boundary.
ALTER TABLE room DROP CONSTRAINT room_state_check;
UPDATE room SET state = 'draft' WHERE state = 'active';
ALTER TABLE room ALTER COLUMN state SET DEFAULT 'draft';
ALTER TABLE room
  ADD CONSTRAINT room_state_check CHECK (state IN ('draft','published','archived')),
  ADD COLUMN title text NOT NULL DEFAULT 'Untitled room' CHECK (length(title) BETWEEN 1 AND 200 AND title = normalize(title,NFC)),
  ADD COLUMN description text NOT NULL DEFAULT '' CHECK (length(description) <= 4000 AND description = normalize(description,NFC) AND description !~ '[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]'),
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  ADD COLUMN working_revision integer NOT NULL DEFAULT 1 CHECK (working_revision > 0),
  ADD COLUMN published_revision integer NOT NULL DEFAULT 0 CHECK (published_revision >= 0),
  ADD COLUMN published_at timestamptz;
COMMENT ON TABLE room IS 'Room lifecycle and optimistic working/published structure revisions.';

CREATE FUNCTION canonical_structure_name(value text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT normalize(lower(btrim(value)),NFC)
$$;
CREATE FUNCTION valid_structure_text(value text, maximum integer, allow_empty boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT value = normalize(value,NFC)
    AND length(value) <= maximum
    AND (allow_empty OR length(value) >= 1)
    AND value !~ '[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]'
$$;

CREATE TABLE folder (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{32}$'),
  room_id text NOT NULL REFERENCES room(id),
  description text NOT NULL DEFAULT '' CHECK (valid_structure_text(description,4000,true)),
  created_by text NOT NULL REFERENCES member(id),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

ALTER TABLE document
  ADD COLUMN description text NOT NULL DEFAULT '' CHECK (valid_structure_text(description,4000,true)),
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  ADD COLUMN working_version_id text REFERENCES document_version(id);
ALTER TABLE document DROP CONSTRAINT document_display_title_check;
ALTER TABLE document ADD CONSTRAINT document_display_title_check
  CHECK (valid_structure_text(display_title,200,false));

CREATE TABLE working_structure_entry (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{32}$'),
  room_id text NOT NULL REFERENCES room(id),
  folder_id text REFERENCES folder(id),
  document_id text REFERENCES document(id),
  parent_folder_id text REFERENCES folder(id),
  display_name text NOT NULL CHECK (valid_structure_text(display_name,200,false)),
  normalized_name text GENERATED ALWAYS AS (canonical_structure_name(display_name)) STORED,
  order_key numeric(30,15) NOT NULL CHECK (order_key > 0),
  staged_removed boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK ((folder_id IS NOT NULL)::integer + (document_id IS NOT NULL)::integer = 1)
);
CREATE UNIQUE INDEX one_working_folder_entry ON working_structure_entry(folder_id) WHERE folder_id IS NOT NULL;
CREATE UNIQUE INDEX one_working_document_entry ON working_structure_entry(document_id) WHERE document_id IS NOT NULL;
CREATE UNIQUE INDEX unique_working_sibling_name ON working_structure_entry
  (room_id,COALESCE(parent_folder_id,''),normalized_name) WHERE NOT staged_removed;
CREATE UNIQUE INDEX unique_working_sibling_order ON working_structure_entry
  (room_id,COALESCE(parent_folder_id,''),order_key) WHERE NOT staged_removed;
CREATE INDEX working_structure_parent_order ON working_structure_entry
  (room_id,parent_folder_id,order_key,id) WHERE NOT staged_removed;

CREATE FUNCTION enforce_working_structure_integrity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE parent_room text; cursor_id text; levels integer := 0; descendant_levels integer := 0;
BEGIN
  IF NEW.folder_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM folder f WHERE f.id = NEW.folder_id AND f.room_id = NEW.room_id
  ) THEN RAISE EXCEPTION 'folder room mismatch' USING ERRCODE = '23514'; END IF;
  IF NEW.document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM document d WHERE d.id = NEW.document_id AND d.room_id = NEW.room_id
  ) THEN RAISE EXCEPTION 'document room mismatch' USING ERRCODE = '23514'; END IF;
  cursor_id := NEW.parent_folder_id;
  WHILE cursor_id IS NOT NULL LOOP
    levels := levels + 1;
    IF levels > 5 THEN RAISE EXCEPTION 'folder depth exceeds five levels' USING ERRCODE = '23514'; END IF;
    IF cursor_id = NEW.folder_id THEN RAISE EXCEPTION 'folder cycle rejected' USING ERRCODE = '23514'; END IF;
    SELECT e.room_id,e.parent_folder_id INTO parent_room,cursor_id
      FROM working_structure_entry e WHERE e.folder_id = cursor_id AND NOT e.staged_removed;
    IF NOT FOUND OR parent_room <> NEW.room_id THEN
      RAISE EXCEPTION 'working parent unavailable' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  IF NEW.folder_id IS NOT NULL THEN
    WITH RECURSIVE descendants(folder_id,levels) AS (
      SELECT e.folder_id,1 FROM working_structure_entry e
        WHERE e.parent_folder_id=NEW.folder_id AND e.folder_id IS NOT NULL
          AND e.id<>NEW.id AND NOT e.staged_removed
      UNION ALL
      SELECT child.folder_id,descendants.levels+1
        FROM descendants JOIN working_structure_entry child
          ON child.parent_folder_id=descendants.folder_id
        WHERE child.folder_id IS NOT NULL AND child.id<>NEW.id AND NOT child.staged_removed
          AND descendants.levels<6
    ) SELECT COALESCE(max(descendants.levels),0) INTO descendant_levels FROM descendants;
    IF levels + 1 + descendant_levels > 5 THEN
      RAISE EXCEPTION 'folder depth exceeds five levels' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER working_structure_integrity BEFORE INSERT OR UPDATE OF room_id,folder_id,document_id,parent_folder_id,staged_removed
ON working_structure_entry FOR EACH ROW EXECUTE FUNCTION enforce_working_structure_integrity();

CREATE TABLE published_structure_entry (
  room_id text NOT NULL REFERENCES room(id),
  entry_id text NOT NULL,
  resource_kind text NOT NULL CHECK (resource_kind IN ('folder','document')),
  resource_id text NOT NULL,
  parent_folder_id text,
  display_name text NOT NULL CHECK (valid_structure_text(display_name,200,false)),
  description text NOT NULL CHECK (valid_structure_text(description,4000,true)),
  order_key numeric(30,15) NOT NULL,
  source_revision integer NOT NULL CHECK (source_revision > 0),
  published_version_id text REFERENCES document_version(id),
  PRIMARY KEY (room_id,entry_id),
  CHECK ((resource_kind = 'folder' AND published_version_id IS NULL) OR
         (resource_kind = 'document' AND published_version_id IS NOT NULL))
);
CREATE INDEX published_structure_parent_order ON published_structure_entry
  (room_id,parent_folder_id,order_key,entry_id);
COMMENT ON TABLE published_structure_entry IS 'Current immutable-by-runtime viewer projection, replaced atomically at publication.';

CREATE FUNCTION enforce_room_state_transition() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF NOT (OLD.state = NEW.state OR
    (OLD.state = 'draft' AND NEW.state IN ('published','archived')) OR
    (OLD.state = 'published' AND NEW.state IN ('draft','archived')) OR
    (OLD.state = 'archived' AND NEW.state = 'draft')) THEN
    RAISE EXCEPTION 'invalid room state transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER room_state_transition BEFORE UPDATE OF state ON room
FOR EACH ROW EXECUTE FUNCTION enforce_room_state_transition();

CREATE FUNCTION reject_published_structure_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF current_user <> 'duefold_migration' THEN
    RAISE EXCEPTION 'published structure is mutation-function only' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER published_structure_guard BEFORE INSERT OR UPDATE OR DELETE ON published_structure_entry
FOR EACH ROW EXECUTE FUNCTION reject_published_structure_mutation();

REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON folder,working_structure_entry,published_structure_entry FROM PUBLIC,duefold_runtime,duefold_worker;
REVOKE SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON folder,working_structure_entry,published_structure_entry FROM duefold_runtime,duefold_worker;
REVOKE SELECT,UPDATE,DELETE,TRUNCATE ON room FROM duefold_runtime,duefold_worker;
REVOKE SELECT,UPDATE,DELETE,TRUNCATE ON document FROM duefold_runtime,duefold_worker;

ALTER FUNCTION canonical_structure_name(text) OWNER TO duefold_migration;
ALTER FUNCTION valid_structure_text(text,integer,boolean) OWNER TO duefold_migration;
ALTER FUNCTION enforce_working_structure_integrity() OWNER TO duefold_migration;
ALTER FUNCTION enforce_room_state_transition() OWNER TO duefold_migration;
ALTER FUNCTION reject_published_structure_mutation() OWNER TO duefold_migration;
ALTER TABLE folder OWNER TO duefold_migration;
ALTER TABLE working_structure_entry OWNER TO duefold_migration;
ALTER TABLE published_structure_entry OWNER TO duefold_migration;

CREATE FUNCTION member_can_mutate_room(p_actor_id text,p_room_id text,p_manager_only boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public,pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM member m LEFT JOIN room_assignment a
      ON a.member_id=m.id AND a.room_id=p_room_id AND a.state='active'
    WHERE m.id=p_actor_id AND m.state='active' AND
      (m.global_role IN ('owner','admin') OR
       (NOT p_manager_only AND a.room_role IN ('manager','contributor')) OR
       (p_manager_only AND a.room_role='manager'))
  )
$$;

/* Narrow read contracts: the shared web credential has no table-wide SELECT on
 * room structure. Each function projects only the fields its named caller needs. */
CREATE FUNCTION authorize_upload_destination(p_actor_id text,p_room_id text,p_document_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS(
    SELECT 1 FROM room r JOIN member m ON m.id=p_actor_id AND m.state='active'
    LEFT JOIN room_assignment a ON a.room_id=r.id AND a.member_id=m.id AND a.state='active'
    WHERE r.id=p_room_id AND r.state<>'archived'
      AND (m.global_role IN ('owner','admin') OR a.room_role IN ('manager','contributor'))
      AND (p_document_id IS NULL OR EXISTS(
        SELECT 1 FROM document d WHERE d.id=p_document_id AND d.room_id=r.id))
  )
$$;
CREATE FUNCTION read_retryable_version(p_version_id text,p_actor_id text)
RETURNS TABLE(room_id text,declared_media_type text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT d.room_id,v.declared_media_type FROM document_version v
  JOIN document d ON d.id=v.document_id JOIN room r ON r.id=d.room_id AND r.state<>'archived'
  JOIN member m ON m.id=p_actor_id AND m.state='active'
  LEFT JOIN room_assignment a ON a.room_id=d.room_id AND a.member_id=m.id AND a.state='active'
  WHERE v.id=p_version_id AND v.state='processing_failed' AND v.failure_kind='transient'
    AND v.manual_retry_count=0
    AND (m.global_role IN ('owner','admin') OR a.room_role IN ('manager','contributor'))
$$;
CREATE FUNCTION read_room_structure_revisions(p_room_id text,p_actor_id text)
RETURNS TABLE(revision integer,working_revision integer,published_revision integer,state text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT r.revision,r.working_revision,r.published_revision,r.state FROM room r
  WHERE r.id=p_room_id AND member_can_mutate_room(p_actor_id,r.id,false)
$$;
CREATE FUNCTION read_structure_entry_revision(p_entry_id text,p_actor_id text)
RETURNS TABLE(revision integer,order_key text,display_name text,parent_folder_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT e.revision,e.order_key::text,e.display_name,e.parent_folder_id
  FROM working_structure_entry e
  WHERE e.id=p_entry_id AND member_can_mutate_room(p_actor_id,e.room_id,false)
$$;
CREATE FUNCTION read_document_revision(p_document_id text,p_actor_id text)
RETURNS TABLE(revision integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT d.revision FROM document d
  WHERE d.id=p_document_id AND member_can_mutate_room(p_actor_id,d.room_id,false)
$$;

CREATE FUNCTION create_folder_entry(
  p_id text,p_room_id text,p_parent_folder_id text,p_display_name text,p_description text,
  p_order_key numeric,p_actor_id text,p_expected_working_revision integer,
  p_audit_id text,p_correlation_id text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE next_revision integer;
BEGIN
  IF NOT member_can_mutate_room(p_actor_id,p_room_id,false) THEN
    RAISE EXCEPTION 'room contribution forbidden' USING ERRCODE='42501';
  END IF;
  UPDATE room SET working_revision=working_revision+1
    WHERE id=p_room_id AND state<>'archived' AND working_revision=p_expected_working_revision
    RETURNING working_revision INTO next_revision;
  IF next_revision IS NULL THEN RAISE EXCEPTION 'stale room structure' USING ERRCODE='40001'; END IF;
  INSERT INTO folder(id,room_id,description,created_by) VALUES(p_id,p_room_id,p_description,p_actor_id);
  INSERT INTO working_structure_entry(id,room_id,folder_id,parent_folder_id,display_name,order_key)
    VALUES(p_id,p_room_id,p_id,p_parent_folder_id,p_display_name,p_order_key);
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,result,reason_code,correlation_id,detail)
    VALUES(p_audit_id,'room.structure','member',p_actor_id,p_room_id,'folder',p_id,'success','FOLDER_CREATED',p_correlation_id,
      jsonb_build_object('workingRevision',next_revision));
  RETURN next_revision;
END $$;

CREATE FUNCTION create_document_entry(
  p_entry_id text,p_document_id text,p_parent_folder_id text,p_display_name text,
  p_order_key numeric,p_actor_id text,p_expected_working_revision integer,
  p_audit_id text,p_correlation_id text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected_room text; next_revision integer;
BEGIN
  SELECT room_id INTO selected_room FROM document WHERE id=p_document_id;
  IF selected_room IS NULL OR NOT member_can_mutate_room(p_actor_id,selected_room,false) THEN
    RAISE EXCEPTION 'room contribution forbidden' USING ERRCODE='42501';
  END IF;
  UPDATE room SET working_revision=working_revision+1
    WHERE id=selected_room AND state<>'archived' AND working_revision=p_expected_working_revision
    RETURNING working_revision INTO next_revision;
  IF next_revision IS NULL THEN RAISE EXCEPTION 'stale room structure' USING ERRCODE='40001'; END IF;
  UPDATE document SET display_title=p_display_name,revision=revision+1 WHERE id=p_document_id;
  INSERT INTO working_structure_entry(id,room_id,document_id,parent_folder_id,display_name,order_key)
    VALUES(p_entry_id,selected_room,p_document_id,p_parent_folder_id,p_display_name,p_order_key);
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,result,reason_code,correlation_id,detail)
    VALUES(p_audit_id,'room.structure','member',p_actor_id,selected_room,'document',p_document_id,'success','DOCUMENT_ATTACHED',p_correlation_id,
      jsonb_build_object('workingRevision',next_revision));
  RETURN next_revision;
END $$;

CREATE FUNCTION mutate_structure_entry(
  p_entry_id text,p_parent_folder_id text,p_display_name text,p_order_key numeric,p_staged_removed boolean,
  p_actor_id text,p_expected_entry_revision integer,p_expected_working_revision integer,
  p_audit_id text,p_correlation_id text
) RETURNS TABLE(entry_revision integer,working_revision integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected_room text; next_entry integer; next_working integer;
BEGIN
  SELECT room_id INTO selected_room FROM working_structure_entry WHERE id=p_entry_id;
  IF selected_room IS NULL OR NOT member_can_mutate_room(p_actor_id,selected_room,false) THEN
    RAISE EXCEPTION 'room contribution forbidden' USING ERRCODE='42501';
  END IF;
  UPDATE room SET working_revision=room.working_revision+1
    WHERE id=selected_room AND state<>'archived' AND room.working_revision=p_expected_working_revision
    RETURNING room.working_revision INTO next_working;
  IF next_working IS NULL THEN RAISE EXCEPTION 'stale room structure' USING ERRCODE='40001'; END IF;
  UPDATE working_structure_entry SET parent_folder_id=p_parent_folder_id,display_name=p_display_name,
      order_key=p_order_key,staged_removed=p_staged_removed,revision=revision+1
    WHERE id=p_entry_id AND revision=p_expected_entry_revision
    RETURNING revision INTO next_entry;
  IF next_entry IS NULL THEN RAISE EXCEPTION 'stale structure entry' USING ERRCODE='40001'; END IF;
  IF EXISTS(SELECT 1 FROM working_structure_entry WHERE id=p_entry_id AND document_id IS NOT NULL) THEN
    UPDATE document SET display_title=p_display_name,revision=revision+1
      WHERE id=(SELECT document_id FROM working_structure_entry WHERE id=p_entry_id);
  END IF;
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,result,reason_code,correlation_id,detail)
    VALUES(p_audit_id,'room.structure','member',p_actor_id,selected_room,'structure_entry',p_entry_id,'success',
      CASE WHEN p_staged_removed THEN 'REMOVAL_STAGED' ELSE 'STRUCTURE_CHANGED' END,p_correlation_id,
      jsonb_build_object('entryRevision',next_entry,'workingRevision',next_working));
  RETURN QUERY SELECT next_entry,next_working;
END $$;

CREATE FUNCTION update_folder_description(
  p_folder_id text,p_description text,p_actor_id text,p_expected_entry_revision integer,p_expected_working_revision integer,
  p_audit_id text,p_correlation_id text
) RETURNS TABLE(entry_revision integer,working_revision integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected_room text; next_entry integer; next_working integer;
BEGIN
  SELECT e.room_id INTO selected_room FROM working_structure_entry e WHERE e.folder_id=p_folder_id;
  IF selected_room IS NULL OR NOT member_can_mutate_room(p_actor_id,selected_room,false) THEN RAISE EXCEPTION 'room contribution forbidden' USING ERRCODE='42501'; END IF;
  UPDATE room SET working_revision=room.working_revision+1 WHERE id=selected_room AND state<>'archived' AND room.working_revision=p_expected_working_revision RETURNING room.working_revision INTO next_working;
  IF next_working IS NULL THEN RAISE EXCEPTION 'stale room structure' USING ERRCODE='40001'; END IF;
  UPDATE working_structure_entry SET revision=revision+1 WHERE folder_id=p_folder_id AND revision=p_expected_entry_revision RETURNING revision INTO next_entry;
  IF next_entry IS NULL THEN RAISE EXCEPTION 'stale structure entry' USING ERRCODE='40001'; END IF;
  UPDATE folder SET description=p_description WHERE id=p_folder_id;
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,result,reason_code,correlation_id,detail)
    VALUES(p_audit_id,'room.metadata','member',p_actor_id,selected_room,'folder',p_folder_id,'success','FOLDER_METADATA_STAGED',p_correlation_id,jsonb_build_object('entryRevision',next_entry,'workingRevision',next_working));
  RETURN QUERY SELECT next_entry,next_working;
END $$;

CREATE FUNCTION version_has_publication_evidence(p_version_id text,p_document_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS(
    SELECT 1 FROM document_version v
    JOIN document_scan_evidence s ON s.version_id=v.id
      AND s.signature_version=v.scan_signature_version
    WHERE v.id=p_version_id AND v.document_id=p_document_id AND v.state='ready_for_review'
      AND EXISTS(SELECT 1 FROM document_derivative dd WHERE dd.version_id=v.id)
  )
$$;

CREATE FUNCTION update_document_metadata(
  p_document_id text,p_title text,p_description text,p_working_version_id text,p_actor_id text,
  p_expected_document_revision integer,p_expected_working_revision integer,p_audit_id text,p_correlation_id text
) RETURNS TABLE(document_revision integer,working_revision integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected_room text; next_document integer; next_working integer; selected_entry text;
BEGIN
  SELECT d.room_id,e.id INTO selected_room,selected_entry FROM document d JOIN working_structure_entry e ON e.document_id=d.id WHERE d.id=p_document_id;
  IF selected_room IS NULL OR NOT member_can_mutate_room(p_actor_id,selected_room,false) THEN RAISE EXCEPTION 'room contribution forbidden' USING ERRCODE='42501'; END IF;
  IF p_working_version_id IS NOT NULL AND NOT version_has_publication_evidence(p_working_version_id,p_document_id) THEN
    RAISE EXCEPTION 'working version is not ready' USING ERRCODE='23514';
  END IF;
  UPDATE room SET working_revision=room.working_revision+1 WHERE id=selected_room AND state<>'archived' AND room.working_revision=p_expected_working_revision RETURNING room.working_revision INTO next_working;
  IF next_working IS NULL THEN RAISE EXCEPTION 'stale room structure' USING ERRCODE='40001'; END IF;
  UPDATE document SET display_title=p_title,description=p_description,working_version_id=p_working_version_id,revision=revision+1
    WHERE id=p_document_id AND revision=p_expected_document_revision RETURNING revision INTO next_document;
  IF next_document IS NULL THEN RAISE EXCEPTION 'stale document metadata' USING ERRCODE='40001'; END IF;
  UPDATE working_structure_entry SET display_name=p_title,revision=revision+1 WHERE id=selected_entry;
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,result,reason_code,correlation_id,detail)
    VALUES(p_audit_id,'room.metadata','member',p_actor_id,selected_room,'document',p_document_id,'success','DOCUMENT_METADATA_STAGED',p_correlation_id,
      jsonb_build_object('documentRevision',next_document,'workingRevision',next_working,'versionId',p_working_version_id));
  RETURN QUERY SELECT next_document,next_working;
END $$;

CREATE FUNCTION rebalance_structure_siblings(
  p_room_id text,p_parent_folder_id text,p_actor_id text,p_expected_working_revision integer,p_audit_id text,p_correlation_id text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE sibling_count integer; next_working integer;
BEGIN
  IF NOT member_can_mutate_room(p_actor_id,p_room_id,false) THEN RAISE EXCEPTION 'room contribution forbidden' USING ERRCODE='42501'; END IF;
  SELECT count(*) INTO sibling_count FROM working_structure_entry WHERE room_id=p_room_id AND parent_folder_id IS NOT DISTINCT FROM p_parent_folder_id AND NOT staged_removed;
  IF sibling_count>1000 THEN RAISE EXCEPTION 'sibling rebalance bound exceeded' USING ERRCODE='54000'; END IF;
  UPDATE room SET working_revision=working_revision+1 WHERE id=p_room_id AND state<>'archived' AND working_revision=p_expected_working_revision RETURNING working_revision INTO next_working;
  IF next_working IS NULL THEN RAISE EXCEPTION 'stale room structure' USING ERRCODE='40001'; END IF;
  WITH ranked AS (SELECT id,row_number() OVER(ORDER BY order_key,id) AS position FROM working_structure_entry WHERE room_id=p_room_id AND parent_folder_id IS NOT DISTINCT FROM p_parent_folder_id AND NOT staged_removed)
  UPDATE working_structure_entry e SET order_key=ranked.position*1024,revision=e.revision+1 FROM ranked WHERE e.id=ranked.id;
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,result,reason_code,correlation_id,detail)
    VALUES(p_audit_id,'room.structure','member',p_actor_id,p_room_id,'room',p_room_id,'success','ORDER_REBALANCED',p_correlation_id,jsonb_build_object('workingRevision',next_working,'count',sibling_count));
  RETURN next_working;
END $$;

CREATE FUNCTION publish_room_structure(
  p_room_id text,p_actor_id text,p_expected_working_revision integer,p_expected_published_revision integer,p_audit_id text,p_correlation_id text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE next_published integer; published_count integer;
BEGIN
  IF NOT member_can_mutate_room(p_actor_id,p_room_id,true) THEN RAISE EXCEPTION 'room management forbidden' USING ERRCODE='42501'; END IF;
  IF EXISTS(
    WITH RECURSIVE included AS (
      SELECT e.* FROM working_structure_entry e
        WHERE e.room_id=p_room_id AND e.parent_folder_id IS NULL AND NOT e.staged_removed
      UNION ALL
      SELECT child.* FROM included parent JOIN working_structure_entry child
        ON child.parent_folder_id=parent.folder_id
        WHERE child.room_id=p_room_id AND NOT child.staged_removed
    )
    SELECT 1 FROM included e JOIN document d ON d.id=e.document_id
    WHERE d.working_version_id IS NOT NULL
      AND NOT version_has_publication_evidence(d.working_version_id,d.id)
  ) THEN
    RAISE EXCEPTION 'document version lacks publication evidence' USING ERRCODE='23514';
  END IF;
  UPDATE room SET published_revision=published_revision+1,published_at=transaction_timestamp(),revision=revision+1
    WHERE id=p_room_id AND state<>'archived' AND working_revision=p_expected_working_revision AND published_revision=p_expected_published_revision
    RETURNING published_revision INTO next_published;
  IF next_published IS NULL THEN RAISE EXCEPTION 'stale publication' USING ERRCODE='40001'; END IF;
  DELETE FROM published_structure_entry WHERE room_id=p_room_id;
  WITH RECURSIVE included AS (
    SELECT e.* FROM working_structure_entry e
      WHERE e.room_id=p_room_id AND e.parent_folder_id IS NULL AND NOT e.staged_removed
    UNION ALL
    SELECT child.* FROM included parent JOIN working_structure_entry child
      ON child.parent_folder_id=parent.folder_id
      WHERE child.room_id=p_room_id AND NOT child.staged_removed
  )
  INSERT INTO published_structure_entry(room_id,entry_id,resource_kind,resource_id,parent_folder_id,display_name,description,order_key,source_revision,published_version_id)
  SELECT e.room_id,e.id,CASE WHEN e.folder_id IS NOT NULL THEN 'folder' ELSE 'document' END,
    COALESCE(e.folder_id,e.document_id),e.parent_folder_id,e.display_name,
    CASE WHEN e.folder_id IS NOT NULL THEN f.description ELSE d.description END,e.order_key,e.revision,d.working_version_id
  FROM included e LEFT JOIN folder f ON f.id=e.folder_id LEFT JOIN document d ON d.id=e.document_id
  WHERE e.folder_id IS NOT NULL OR (d.working_version_id IS NOT NULL AND
    version_has_publication_evidence(d.working_version_id,d.id));
  GET DIAGNOSTICS published_count=ROW_COUNT;
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,result,reason_code,correlation_id,detail)
    VALUES(p_audit_id,'room.publish','member',p_actor_id,p_room_id,'room',p_room_id,'success','STRUCTURE_PUBLISHED',p_correlation_id,
      jsonb_build_object('workingRevision',p_expected_working_revision,'publishedRevision',next_published,'entryCount',published_count,
        'versionIds',(SELECT COALESCE(jsonb_agg(published_version_id ORDER BY published_version_id),'[]'::jsonb) FROM published_structure_entry WHERE room_id=p_room_id AND published_version_id IS NOT NULL)));
  RETURN next_published;
END $$;

CREATE FUNCTION change_room_state(
  p_room_id text,p_state text,p_actor_id text,p_expected_revision integer,p_audit_id text,p_correlation_id text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE next_revision integer;
BEGIN
  IF NOT member_can_mutate_room(p_actor_id,p_room_id,true) THEN RAISE EXCEPTION 'room management forbidden' USING ERRCODE='42501'; END IF;
  UPDATE room SET state=p_state,revision=revision+1 WHERE id=p_room_id AND revision=p_expected_revision
    AND (p_state<>'published' OR published_revision>0) RETURNING revision INTO next_revision;
  IF next_revision IS NULL THEN RAISE EXCEPTION 'stale or invalid room state change' USING ERRCODE='40001'; END IF;
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,result,reason_code,correlation_id,detail)
    VALUES(p_audit_id,'room.state','member',p_actor_id,p_room_id,'room',p_room_id,'success',
      CASE p_state WHEN 'draft' THEN 'ROOM_UNPUBLISHED' WHEN 'published' THEN 'ROOM_PUBLISHED' ELSE 'ROOM_ARCHIVED' END,
      p_correlation_id,jsonb_build_object('roomRevision',next_revision));
  RETURN next_revision;
END $$;

REVOKE ALL ON FUNCTION member_can_mutate_room(text,text,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION authorize_upload_destination(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION read_retryable_version(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION read_room_structure_revisions(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION read_structure_entry_revision(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION read_document_revision(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authorize_upload_destination(text,text,text),
 read_retryable_version(text,text),read_room_structure_revisions(text,text),
 read_structure_entry_revision(text,text),read_document_revision(text,text) TO duefold_runtime;
REVOKE ALL ON FUNCTION create_folder_entry(text,text,text,text,text,numeric,text,integer,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_document_entry(text,text,text,text,numeric,text,integer,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION mutate_structure_entry(text,text,text,numeric,boolean,text,integer,integer,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION update_folder_description(text,text,text,integer,integer,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION version_has_publication_evidence(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION update_document_metadata(text,text,text,text,text,integer,integer,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION rebalance_structure_siblings(text,text,text,integer,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION publish_room_structure(text,text,integer,integer,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION change_room_state(text,text,text,integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_folder_entry(text,text,text,text,text,numeric,text,integer,text,text),
 create_document_entry(text,text,text,text,numeric,text,integer,text,text),
 mutate_structure_entry(text,text,text,numeric,boolean,text,integer,integer,text,text),
 update_folder_description(text,text,text,integer,integer,text,text),
 update_document_metadata(text,text,text,text,text,integer,integer,text,text),
 rebalance_structure_siblings(text,text,text,integer,text,text),
 publish_room_structure(text,text,integer,integer,text,text),
 change_room_state(text,text,text,integer,text,text) TO duefold_runtime;
ALTER FUNCTION member_can_mutate_room(text,text,boolean) OWNER TO duefold_migration;
ALTER FUNCTION authorize_upload_destination(text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION read_retryable_version(text,text) OWNER TO duefold_migration;
ALTER FUNCTION read_room_structure_revisions(text,text) OWNER TO duefold_migration;
ALTER FUNCTION read_structure_entry_revision(text,text) OWNER TO duefold_migration;
ALTER FUNCTION read_document_revision(text,text) OWNER TO duefold_migration;
ALTER FUNCTION create_folder_entry(text,text,text,text,text,numeric,text,integer,text,text) OWNER TO duefold_migration;
ALTER FUNCTION create_document_entry(text,text,text,text,numeric,text,integer,text,text) OWNER TO duefold_migration;
ALTER FUNCTION mutate_structure_entry(text,text,text,numeric,boolean,text,integer,integer,text,text) OWNER TO duefold_migration;
ALTER FUNCTION update_folder_description(text,text,text,integer,integer,text,text) OWNER TO duefold_migration;
ALTER FUNCTION version_has_publication_evidence(text,text) OWNER TO duefold_migration;
ALTER FUNCTION update_document_metadata(text,text,text,text,text,integer,integer,text,text) OWNER TO duefold_migration;
ALTER FUNCTION rebalance_structure_siblings(text,text,text,integer,text,text) OWNER TO duefold_migration;
ALTER FUNCTION publish_room_structure(text,text,integer,integer,text,text) OWNER TO duefold_migration;
ALTER FUNCTION change_room_state(text,text,text,integer,text,text) OWNER TO duefold_migration;

CREATE FUNCTION create_room(
  p_id text,p_title text,p_description text,p_actor_id text,p_audit_id text,p_correlation_id text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM member WHERE id=p_actor_id AND state='active' AND global_role IN ('owner','admin')) THEN
    RAISE EXCEPTION 'room creation forbidden' USING ERRCODE='42501';
  END IF;
  INSERT INTO room(id,title,description) VALUES(p_id,p_title,p_description);
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,result,reason_code,correlation_id)
    VALUES(p_audit_id,'room.create','member',p_actor_id,p_id,'room',p_id,'success','ROOM_CREATED',p_correlation_id);
END $$;
REVOKE INSERT ON room FROM duefold_runtime,duefold_worker;
REVOKE ALL ON FUNCTION create_room(text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_room(text,text,text,text,text,text) TO duefold_runtime;
ALTER FUNCTION create_room(text,text,text,text,text,text) OWNER TO duefold_migration;

-- Room lifecycle states. Member cleanup remains
-- available in draft/published rooms and remains denied in archived rooms.
CREATE OR REPLACE FUNCTION begin_member_failed_source_deletion(
  p_version_id text, p_actor_id text, p_global_role text, p_audit_id text, p_correlation_id text
) RETURNS TABLE(object_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE current_state text; selected_key text; selected_room text;
BEGIN
  SELECT v.state,v.object_key,d.room_id INTO current_state,selected_key,selected_room
  FROM document_version v JOIN document d ON d.id = v.document_id
  JOIN room r ON r.id = d.room_id AND r.state <> 'archived'
  LEFT JOIN room_assignment a ON a.room_id = d.room_id AND a.member_id = p_actor_id AND a.state = 'active'
  WHERE v.id = p_version_id
    AND v.state IN ('rejected','processing_failed','malware_quarantined','failed_source_deletion_pending','malware_source_deletion_pending')
    AND (p_global_role IN ('owner','admin') OR a.room_role IN ('manager','contributor'))
  FOR UPDATE OF v;
  IF selected_key IS NULL THEN RAISE EXCEPTION 'failed source delete forbidden' USING ERRCODE = '55000'; END IF;
  IF current_state NOT LIKE '%_deletion_pending' THEN
    UPDATE document_version SET state = CASE WHEN current_state = 'malware_quarantined' THEN 'malware_source_deletion_pending' ELSE 'failed_source_deletion_pending' END WHERE id = p_version_id;
    INSERT INTO audit_event(id,event_type,actor_kind,actor_id,subject_id,room_id,resource_type,resource_id,result,reason_code,correlation_id)
    VALUES (p_audit_id,'document.retention','member',p_actor_id,p_version_id,selected_room,'document_version',p_version_id,'success','FAILED_SOURCE_DELETION_PENDING',p_correlation_id);
  END IF;
  RETURN QUERY SELECT selected_key;
END $$;

CREATE OR REPLACE FUNCTION finalize_member_failed_source_deletion(
  p_version_id text, p_actor_id text, p_global_role text, p_audit_id text, p_correlation_id text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE selected_room text;
BEGIN
  UPDATE document_version v SET state = CASE WHEN v.state = 'malware_source_deletion_pending' THEN 'malware_source_deleted' ELSE 'failed_source_deleted' END
  FROM document d JOIN room r ON r.id=d.room_id AND r.state <> 'archived'
  LEFT JOIN room_assignment a ON a.room_id = d.room_id AND a.member_id = p_actor_id AND a.state = 'active'
  WHERE v.id = p_version_id AND d.id = v.document_id
    AND v.state IN ('failed_source_deletion_pending','malware_source_deletion_pending')
    AND (p_global_role IN ('owner','admin') OR a.room_role IN ('manager','contributor'))
  RETURNING d.room_id INTO selected_room;
  IF selected_room IS NULL THEN RAISE EXCEPTION 'failed source delete conflict' USING ERRCODE = '55000'; END IF;
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,subject_id,room_id,resource_type,resource_id,result,reason_code,correlation_id)
  VALUES (p_audit_id,'document.retention','member',p_actor_id,p_version_id,selected_room,'document_version',p_version_id,'success','FAILED_SOURCE_DELETED_EARLY',p_correlation_id);
END $$;
ALTER FUNCTION begin_member_failed_source_deletion(text,text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION finalize_member_failed_source_deletion(text,text,text,text,text) OWNER TO duefold_migration;
