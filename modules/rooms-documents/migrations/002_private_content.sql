-- Duefold private content boundary. This migration is immutable after application.
CREATE TABLE room (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{32}$'),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
COMMENT ON TABLE room IS 'Top-level authorization boundary for document rooms and member assignments.';
ALTER TABLE room_assignment ADD CONSTRAINT room_assignment_room_fk
  FOREIGN KEY (room_id) REFERENCES room(id);

CREATE TABLE document (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{32}$'),
  room_id text NOT NULL REFERENCES room(id),
  display_title text NOT NULL CHECK (length(display_title) BETWEEN 1 AND 200),
  created_by text NOT NULL REFERENCES member(id),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE document_version (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{32}$'),
  document_id text NOT NULL REFERENCES document(id),
  original_filename text NOT NULL CHECK (length(original_filename) BETWEEN 1 AND 255),
  object_key text NOT NULL UNIQUE CHECK (object_key ~ '^quarantine/[A-Za-z0-9_-]{32}/[A-Za-z0-9_-]{32}$'),
  declared_media_type text NOT NULL CHECK (declared_media_type IN (
    'application/pdf','image/png','image/jpeg','image/webp','text/plain','text/csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.oasis.opendocument.spreadsheet')),
  detected_media_type text CHECK (detected_media_type IN (
    'application/pdf','image/png','image/jpeg','image/webp','text/plain','text/csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.oasis.opendocument.spreadsheet')),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 262144000),
  sha256 char(64) CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  processing_attempts smallint NOT NULL DEFAULT 0 CHECK (processing_attempts BETWEEN 0 AND 10),
  state text NOT NULL DEFAULT 'quarantine' CHECK (state IN ('quarantine','source_validated','rejected')),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK ((state = 'source_validated' AND detected_media_type IS NOT NULL AND sha256 IS NOT NULL) OR
         (state <> 'source_validated'))
);
COMMENT ON COLUMN document_version.original_filename IS 'Private source metadata; never viewer-facing.';
COMMENT ON COLUMN document_version.sha256 IS 'Internal integrity evidence only; never viewer-facing or a deduplication key.';

CREATE FUNCTION enforce_version_immutability() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF OLD.state = 'source_validated' OR
     OLD.document_id IS DISTINCT FROM NEW.document_id OR
     OLD.original_filename IS DISTINCT FROM NEW.original_filename OR
     OLD.object_key IS DISTINCT FROM NEW.object_key OR
     OLD.declared_media_type IS DISTINCT FROM NEW.declared_media_type OR
     OLD.size_bytes IS DISTINCT FROM NEW.size_bytes OR
     OLD.created_at IS DISTINCT FROM NEW.created_at OR
     (OLD.detected_media_type IS NOT NULL AND OLD.detected_media_type IS DISTINCT FROM NEW.detected_media_type) OR
     (OLD.sha256 IS NOT NULL AND OLD.sha256 IS DISTINCT FROM NEW.sha256) THEN
    RAISE EXCEPTION 'accepted document versions are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_version_immutable BEFORE UPDATE ON document_version
FOR EACH ROW EXECUTE FUNCTION enforce_version_immutability();

CREATE TABLE upload_intent (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{32}$'),
  room_id text NOT NULL REFERENCES room(id),
  member_id text NOT NULL REFERENCES member(id),
  document_id text REFERENCES document(id),
  display_title text NOT NULL CHECK (length(display_title) BETWEEN 1 AND 200),
  original_filename text NOT NULL CHECK (length(original_filename) BETWEEN 1 AND 255),
  declared_media_type text NOT NULL CHECK (declared_media_type IN (
    'application/pdf','image/png','image/jpeg','image/webp','text/plain','text/csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.oasis.opendocument.spreadsheet')),
  declared_size bigint NOT NULL CHECK (declared_size BETWEEN 1 AND 262144000),
  object_key text NOT NULL UNIQUE CHECK (object_key ~ '^quarantine/[A-Za-z0-9_-]{32}/[A-Za-z0-9_-]{32}$'),
  upload_id text NOT NULL CHECK (length(upload_id) BETWEEN 1 AND 1024),
  part_plan jsonb NOT NULL CHECK (jsonb_typeof(part_plan) = 'array' AND jsonb_array_length(part_plan) BETWEEN 1 AND 50),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','completing','finalized','expired','failed')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '24 hours 1 minute')
);
CREATE INDEX upload_intent_expiry ON upload_intent (expires_at) WHERE state IN ('open','completing');

CREATE FUNCTION enforce_upload_intent_transition() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF NOT (OLD.state = NEW.state OR
    (OLD.state = 'open' AND NEW.state IN ('completing','expired','failed')) OR
    (OLD.state = 'completing' AND NEW.state IN ('finalized','expired','failed'))) THEN
    RAISE EXCEPTION 'invalid upload intent state transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER upload_intent_state_transition BEFORE UPDATE OF state ON upload_intent
FOR EACH ROW EXECUTE FUNCTION enforce_upload_intent_transition();

/*
 * The web role cannot insert a version row directly. Finalization presents an
 * already-authorized, completing upload intent; this function copies every
 * security-bearing value from that locked intent, creates only a quarantined
 * version, finalizes the intent, and records the audit in the same transaction.
 */
CREATE FUNCTION create_quarantined_document_version(
  p_version_id text,p_document_id text,p_intent_id text,p_actor_id text,
  p_size_bytes bigint,p_audit_id text,p_correlation_id text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected_intent upload_intent%ROWTYPE;
BEGIN
  SELECT * INTO selected_intent FROM upload_intent u
   WHERE u.id=p_intent_id AND u.member_id=p_actor_id AND u.state='completing'
     AND u.expires_at>transaction_timestamp() AND u.declared_size=p_size_bytes
   FOR UPDATE;
  IF selected_intent.id IS NULL THEN
    RAISE EXCEPTION 'upload intent cannot create version' USING ERRCODE='55000';
  END IF;
  IF selected_intent.document_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM document WHERE id=p_document_id) THEN
      RAISE EXCEPTION 'document id already exists' USING ERRCODE='55000';
    END IF;
    INSERT INTO document(id,room_id,display_title,created_by)
      VALUES(p_document_id,selected_intent.room_id,selected_intent.display_title,p_actor_id);
  ELSIF selected_intent.document_id<>p_document_id OR NOT EXISTS(
    SELECT 1 FROM document d WHERE d.id=p_document_id AND d.room_id=selected_intent.room_id
  ) THEN
    RAISE EXCEPTION 'upload destination mismatch' USING ERRCODE='55000';
  END IF;
  INSERT INTO document_version
    (id,document_id,original_filename,object_key,declared_media_type,size_bytes,state)
  VALUES (p_version_id,p_document_id,selected_intent.original_filename,selected_intent.object_key,
    selected_intent.declared_media_type,p_size_bytes,'quarantine');
  UPDATE upload_intent SET state='finalized' WHERE id=p_intent_id;
  INSERT INTO audit_event
    (id,event_type,actor_kind,actor_id,subject_id,room_id,resource_type,resource_id,result,reason_code,correlation_id)
  VALUES (p_audit_id,'upload.finalized','member',p_actor_id,p_intent_id,selected_intent.room_id,
    'document_version',p_version_id,'success','UPLOAD_QUARANTINED',p_correlation_id);
END $$;
REVOKE ALL ON FUNCTION create_quarantined_document_version(text,text,text,text,bigint,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_quarantined_document_version(text,text,text,text,bigint,text,text) TO duefold_runtime;

GRANT SELECT, INSERT, UPDATE, DELETE ON room, document, upload_intent TO duefold_runtime;
/*
 * The web role gets NO table read on document_version. The row carries the
 * original filename and the storage object key, so table-wide SELECT let the
 * shared web credential enumerate every source object installation-wide with no
 * viewer, room, grant, or publication check -- bypassing the viewer-aware
 * projection entirely. Every web path reaches version data through a
 * SECURITY DEFINER function that authorizes first; the worker keeps its own
 * SELECT because credential-free processing legitimately reads object keys.
 */
GRANT SELECT ON document, document_version TO duefold_worker;
GRANT SELECT, UPDATE ON upload_intent TO duefold_worker;
REVOKE DELETE, TRUNCATE ON document_version FROM duefold_runtime, duefold_worker;

ALTER FUNCTION enforce_version_immutability() OWNER TO duefold_migration;
ALTER FUNCTION enforce_upload_intent_transition() OWNER TO duefold_migration;
ALTER FUNCTION create_quarantined_document_version(text,text,text,text,bigint,text,text) OWNER TO duefold_migration;
ALTER TABLE room OWNER TO duefold_migration;
ALTER TABLE document OWNER TO duefold_migration;
ALTER TABLE document_version OWNER TO duefold_migration;
ALTER TABLE upload_intent OWNER TO duefold_migration;
