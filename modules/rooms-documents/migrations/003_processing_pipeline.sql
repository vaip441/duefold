-- Duefold scan, processing, and derivative boundary. This migration is immutable after application.
ALTER TABLE document_version DROP CONSTRAINT document_version_state_check;
ALTER TABLE document_version DROP CONSTRAINT document_version_check;
ALTER TABLE document_version
  ADD COLUMN scan_signature_version text,
  ADD COLUMN failure_kind text CHECK (failure_kind IN ('malware','deterministic','transient')),
  ADD COLUMN failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  ADD COLUMN retained_until timestamptz,
  ADD COLUMN manual_retry_count smallint NOT NULL DEFAULT 0 CHECK (manual_retry_count BETWEEN 0 AND 1),
  ADD COLUMN hidden_sheet_warning boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT document_version_state_check CHECK (state IN (
    'quarantine','source_validated','rejected','malware_quarantined','processing_failed',
    'ready_for_review','failed_source_deletion_pending','malware_source_deletion_pending',
    'failed_source_deleted','malware_source_deleted')),
  ADD CONSTRAINT document_version_processing_evidence CHECK (
    (state = 'ready_for_review' AND detected_media_type IS NOT NULL AND sha256 IS NOT NULL
      AND scan_signature_version IS NOT NULL AND failure_kind IS NULL AND failure_code IS NULL)
    OR (state IN ('malware_quarantined','malware_source_deletion_pending')
      AND failure_kind = 'malware' AND retained_until IS NOT NULL)
    OR (state = 'failed_source_deletion_pending'
      AND failure_kind IN ('deterministic','transient') AND retained_until IS NOT NULL)
    OR (state = 'rejected' AND failure_kind = 'deterministic' AND retained_until IS NOT NULL)
    OR (state = 'processing_failed' AND failure_kind = 'transient' AND retained_until IS NOT NULL)
    OR state IN ('quarantine','source_validated','failed_source_deleted','malware_source_deleted'));

CREATE TABLE scanner_observation (
  version_id text NOT NULL REFERENCES document_version(id),
  job_id text NOT NULL REFERENCES job_queue(id),
  lease_token text NOT NULL CHECK (lease_token ~ '^[A-Za-z0-9_-]{32}$'),
  signature_version text NOT NULL CHECK (signature_version ~ '^[0-9]{1,20}$'),
  signatures_published_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (version_id,job_id,lease_token),
  CHECK (signatures_published_at <= observed_at AND signatures_published_at >= observed_at - interval '24 hours')
);
COMMENT ON TABLE scanner_observation IS 'Immutable scanner-reported VERSION observation recorded by the worker scan step.';

CREATE TABLE document_scan_evidence (
  version_id text NOT NULL REFERENCES document_version(id),
  job_id text NOT NULL REFERENCES job_queue(id),
  lease_token text NOT NULL CHECK (lease_token ~ '^[A-Za-z0-9_-]{32}$'),
  signature_version text NOT NULL CHECK (length(signature_version) BETWEEN 1 AND 100),
  signatures_published_at timestamptz NOT NULL,
  scanned_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (version_id,job_id,lease_token),
  CHECK (signatures_published_at <= scanned_at AND signatures_published_at >= scanned_at - interval '24 hours')
);
COMMENT ON TABLE document_scan_evidence IS 'Immutable clean-scan evidence recorded by a currently leased source-validation job.';

CREATE TABLE document_derivative (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{32}$'),
  version_id text NOT NULL REFERENCES document_version(id),
  page_number integer NOT NULL CHECK (page_number BETWEEN 1 AND 10000),
  object_key text NOT NULL UNIQUE CHECK (object_key ~ '^derivatives/[A-Za-z0-9_-]{32}/[A-Za-z0-9_-]{32}$'),
  media_type text NOT NULL CHECK (media_type IN ('image/png','image/webp')),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 262144000),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 32768),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 32768),
  accessible_label text NOT NULL CHECK (length(accessible_label) BETWEEN 1 AND 500),
  text_layer jsonb CHECK (text_layer IS NULL OR jsonb_typeof(text_layer) = 'array'),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (version_id,page_number)
);
COMMENT ON TABLE document_derivative IS 'Immutable private raster previews; never native accepted source bytes.';
COMMENT ON COLUMN document_derivative.sha256 IS 'Internal integrity evidence, verified before ready-for-review.';

CREATE TABLE verified_derivative_object (
  version_id text NOT NULL REFERENCES document_version(id),
  job_id text NOT NULL REFERENCES job_queue(id),
  lease_token text NOT NULL CHECK (lease_token ~ '^[A-Za-z0-9_-]{32}$'),
  object_key text NOT NULL CHECK (object_key ~ '^derivatives/[A-Za-z0-9_-]{32}/[A-Za-z0-9_-]{32}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 262144000),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  verified_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (version_id,job_id,lease_token,object_key)
);
COMMENT ON TABLE verified_derivative_object IS 'Immutable worker evidence written only after storage read-back byte verification.';

CREATE TABLE derivative_cleanup_intent (
  object_key text PRIMARY KEY CHECK (object_key ~ '^derivatives/[A-Za-z0-9_-]{32}/[A-Za-z0-9_-]{32}$'),
  version_id text NOT NULL REFERENCES document_version(id),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
COMMENT ON TABLE derivative_cleanup_intent IS 'Durable idempotent cleanup intent created before a derivative object write.';

CREATE FUNCTION reject_processing_evidence_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'processing evidence is immutable' USING ERRCODE = '55000';
END $$;
CREATE TRIGGER scanner_observation_immutable BEFORE UPDATE OR DELETE ON scanner_observation
FOR EACH ROW EXECUTE FUNCTION reject_processing_evidence_mutation();
CREATE TRIGGER document_scan_evidence_immutable BEFORE UPDATE OR DELETE ON document_scan_evidence
FOR EACH ROW EXECUTE FUNCTION reject_processing_evidence_mutation();
CREATE TRIGGER verified_derivative_object_immutable BEFORE UPDATE OR DELETE ON verified_derivative_object
FOR EACH ROW EXECUTE FUNCTION reject_processing_evidence_mutation();
CREATE TRIGGER document_derivative_immutable BEFORE UPDATE OR DELETE ON document_derivative
FOR EACH ROW EXECUTE FUNCTION reject_processing_evidence_mutation();

CREATE OR REPLACE FUNCTION enforce_version_immutability() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF OLD.document_id IS DISTINCT FROM NEW.document_id OR
     OLD.original_filename IS DISTINCT FROM NEW.original_filename OR
     OLD.object_key IS DISTINCT FROM NEW.object_key OR
     OLD.declared_media_type IS DISTINCT FROM NEW.declared_media_type OR
     OLD.size_bytes IS DISTINCT FROM NEW.size_bytes OR
     OLD.created_at IS DISTINCT FROM NEW.created_at OR
     (OLD.detected_media_type IS NOT NULL AND OLD.detected_media_type IS DISTINCT FROM NEW.detected_media_type) OR
     (OLD.sha256 IS NOT NULL AND OLD.sha256 IS DISTINCT FROM NEW.sha256) OR
     (OLD.scan_signature_version IS NOT NULL AND OLD.scan_signature_version IS DISTINCT FROM NEW.scan_signature_version) THEN
    RAISE EXCEPTION 'accepted document versions are immutable' USING ERRCODE = '55000';
  END IF;
  IF NOT (OLD.state = NEW.state OR
    (OLD.state = 'quarantine' AND NEW.state IN ('ready_for_review','rejected','malware_quarantined','processing_failed')) OR
    (OLD.state = 'processing_failed' AND NEW.state = 'quarantine' AND
      NEW.manual_retry_count = OLD.manual_retry_count + 1 AND NEW.manual_retry_count = 1) OR
    (OLD.state IN ('rejected','processing_failed') AND NEW.state = 'failed_source_deletion_pending') OR
    (OLD.state = 'malware_quarantined' AND NEW.state = 'malware_source_deletion_pending') OR
    (OLD.state = 'failed_source_deletion_pending' AND NEW.state = 'failed_source_deleted') OR
    (OLD.state = 'malware_source_deletion_pending' AND NEW.state = 'malware_source_deleted')) THEN
    RAISE EXCEPTION 'invalid document version state transition' USING ERRCODE = '23514';
  END IF;
  IF OLD.state IN ('ready_for_review','failed_source_deleted','malware_source_deleted') AND OLD IS DISTINCT FROM NEW THEN
    RAISE EXCEPTION 'terminal document versions are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION record_scanner_observation(
  p_version_id text, p_job_id text, p_lease_owner text, p_lease_token text,
  p_signature_version text, p_signatures_published_at timestamptz
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN
  IF p_signature_version !~ '^[0-9]{1,20}$' OR
     p_signatures_published_at > transaction_timestamp() OR
     p_signatures_published_at < transaction_timestamp() - interval '24 hours' THEN
    RAISE EXCEPTION 'scanner observation invalid or stale' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM document_version v JOIN job_queue j ON j.id = p_job_id
    WHERE v.id = p_version_id AND v.state = 'quarantine'
      AND j.job_type = 'document.source.validate' AND j.payload->>'versionId' = v.id
      AND j.state = 'running' AND j.lease_owner = p_lease_owner
      AND j.lease_token = p_lease_token AND j.lease_expires_at > transaction_timestamp()
  ) THEN RAISE EXCEPTION 'job lease lost' USING ERRCODE = '55000'; END IF;
  INSERT INTO scanner_observation
    (version_id,job_id,lease_token,signature_version,signatures_published_at)
  VALUES (p_version_id,p_job_id,p_lease_token,p_signature_version,p_signatures_published_at)
  ON CONFLICT DO NOTHING;
END $$;

CREATE FUNCTION record_clean_scan(
  p_version_id text, p_job_id text, p_lease_owner text, p_lease_token text,
  p_signature_version text, p_signatures_published_at timestamptz,
  p_audit_id text, p_correlation_id text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM document_version v JOIN job_queue j ON j.id = p_job_id
    JOIN scanner_observation o ON o.version_id = v.id AND o.job_id = j.id
      AND o.lease_token = j.lease_token AND o.signature_version = p_signature_version
      AND o.signatures_published_at = p_signatures_published_at
    WHERE v.id = p_version_id AND v.state = 'quarantine'
      AND j.job_type = 'document.source.validate' AND j.payload->>'versionId' = v.id
      AND j.state = 'running' AND j.lease_owner = p_lease_owner
      AND j.lease_token = p_lease_token AND j.lease_expires_at > transaction_timestamp()
      AND o.observed_at >= transaction_timestamp() - interval '24 hours'
  ) THEN RAISE EXCEPTION 'recorded scanner observation and job lease required' USING ERRCODE = '55000'; END IF;
  INSERT INTO document_scan_evidence
    (version_id,job_id,lease_token,signature_version,signatures_published_at)
  VALUES (p_version_id,p_job_id,p_lease_token,p_signature_version,p_signatures_published_at)
  ON CONFLICT (version_id,job_id,lease_token) DO NOTHING;
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO audit_event
    (id,event_type,actor_kind,subject_id,resource_type,resource_id,result,reason_code,correlation_id)
  VALUES (p_audit_id,'document.processing','system',p_version_id,'document_version',p_version_id,
    'success','SCAN_CLEAN',p_correlation_id);
END $$;

CREATE FUNCTION register_derivative_cleanup(
  p_version_id text, p_object_key text, p_cleanup_job_id text,
  p_job_id text, p_lease_owner text, p_lease_token text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM job_queue j WHERE j.id = p_job_id
    AND j.job_type = 'document.source.validate' AND j.payload->>'versionId' = p_version_id
    AND j.state = 'running' AND j.lease_owner = p_lease_owner AND j.lease_token = p_lease_token
    AND j.lease_expires_at > transaction_timestamp()) THEN
    RAISE EXCEPTION 'job lease lost' USING ERRCODE = '55000';
  END IF;
  INSERT INTO derivative_cleanup_intent (object_key,version_id)
    VALUES (p_object_key,p_version_id) ON CONFLICT DO NOTHING;
  INSERT INTO job_queue (id,job_type,idempotency_key,payload,available_at)
    VALUES (p_cleanup_job_id,'document.derivative.cleanup','derivative-cleanup:' || p_object_key,
      jsonb_build_object('objectKey',p_object_key),transaction_timestamp() + interval '5 minutes')
    ON CONFLICT (idempotency_key) DO NOTHING;
END $$;

CREATE FUNCTION record_verified_derivative(
  p_version_id text, p_job_id text, p_lease_owner text, p_lease_token text,
  p_object_key text, p_size_bytes bigint, p_sha256 text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM job_queue j WHERE j.id = p_job_id
    AND j.job_type = 'document.source.validate' AND j.payload->>'versionId' = p_version_id
    AND j.state = 'running' AND j.lease_owner = p_lease_owner AND j.lease_token = p_lease_token
    AND j.lease_expires_at > transaction_timestamp()) THEN
    RAISE EXCEPTION 'job lease lost' USING ERRCODE = '55000';
  END IF;
  INSERT INTO verified_derivative_object
    (version_id,job_id,lease_token,object_key,size_bytes,sha256)
  VALUES (p_version_id,p_job_id,p_lease_token,p_object_key,p_size_bytes,p_sha256)
  ON CONFLICT DO NOTHING;
END $$;

CREATE FUNCTION resolve_derivative_cleanup(
  p_object_key text, p_job_id text, p_lease_owner text, p_lease_token text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN
  /*
   * The intent row must EXIST: a LEFT JOIN here allowed a cleanup job whose
   * payload merely named an object key to satisfy this check with no recorded
   * intent, so forged cleanup work could delete a live derivative. Cleanup is
   * only ever legitimate for an object some processing attempt registered.
   */
  IF NOT EXISTS (SELECT 1 FROM job_queue j JOIN derivative_cleanup_intent i ON i.object_key = p_object_key
    WHERE j.id = p_job_id AND j.state = 'running' AND j.lease_owner = p_lease_owner
      AND j.lease_token = p_lease_token AND j.lease_expires_at > transaction_timestamp()
      AND ((j.job_type = 'document.source.validate' AND j.payload->>'versionId' = i.version_id)
        OR (j.job_type = 'document.derivative.cleanup' AND j.payload->>'objectKey' = p_object_key))) THEN
    RAISE EXCEPTION 'job lease lost' USING ERRCODE = '55000';
  END IF;
  DELETE FROM derivative_cleanup_intent WHERE object_key = p_object_key;
END $$;

CREATE FUNCTION accept_processed_version(
  p_version_id text, p_job_id text, p_lease_owner text, p_lease_token text,
  p_detected_media_type text, p_sha256 text, p_hidden_sheet_warning boolean,
  p_derivatives jsonb, p_audit_id text, p_correlation_id text, p_hidden_sheet_count integer
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE inserted_count integer;
BEGIN
  IF jsonb_typeof(p_derivatives) <> 'array' OR jsonb_array_length(p_derivatives) < 1
     OR jsonb_array_length(p_derivatives) > 10000 THEN
    RAISE EXCEPTION 'derivative evidence required' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM job_queue j JOIN document_scan_evidence s
      ON s.version_id = p_version_id AND s.job_id = j.id AND s.lease_token = j.lease_token
    WHERE j.id = p_job_id AND j.job_type = 'document.source.validate'
      AND j.payload->>'versionId' = p_version_id AND j.state = 'running'
      AND j.lease_owner = p_lease_owner AND j.lease_token = p_lease_token
      AND j.lease_expires_at > transaction_timestamp()
      AND s.scanned_at >= transaction_timestamp() - interval '24 hours'
      AND s.signatures_published_at >= transaction_timestamp() - interval '24 hours') THEN
    RAISE EXCEPTION 'current clean scan and job lease required' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_derivatives) AS d(object_key text,size_bytes bigint,sha256 text)
    LEFT JOIN verified_derivative_object o ON o.version_id = p_version_id
      AND o.job_id = p_job_id AND o.lease_token = p_lease_token
      AND o.object_key = d.object_key AND o.size_bytes = d.size_bytes AND o.sha256 = d.sha256
    WHERE o.object_key IS NULL
  ) THEN RAISE EXCEPTION 'independent derivative verification required' USING ERRCODE = '55000'; END IF;
  INSERT INTO document_derivative
    (id,version_id,page_number,object_key,media_type,size_bytes,sha256,width,height,accessible_label,text_layer)
  SELECT d.id,p_version_id,d.page_number,d.object_key,d.media_type,d.size_bytes,d.sha256,
    d.width,d.height,d.accessible_label,NULLIF(d.text_layer,'null'::jsonb)
  FROM jsonb_to_recordset(p_derivatives) AS d(
    id text,page_number integer,object_key text,media_type text,size_bytes bigint,
    sha256 text,width integer,height integer,accessible_label text,text_layer jsonb);
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  IF inserted_count <> jsonb_array_length(p_derivatives) THEN
    RAISE EXCEPTION 'derivative evidence incomplete' USING ERRCODE = '23514';
  END IF;
  UPDATE document_version v SET state = 'ready_for_review',detected_media_type = p_detected_media_type,
    sha256 = p_sha256,scan_signature_version = s.signature_version,
    hidden_sheet_warning = p_hidden_sheet_warning,processing_attempts = processing_attempts + 1
  FROM document_scan_evidence s WHERE v.id = p_version_id AND v.state = 'quarantine'
    AND s.version_id = v.id AND s.job_id = p_job_id AND s.lease_token = p_lease_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'document version conflict' USING ERRCODE = '55000'; END IF;
  INSERT INTO audit_event
    (id,event_type,actor_kind,subject_id,resource_type,resource_id,result,reason_code,correlation_id,detail)
  VALUES (p_audit_id,'document.processing','system',p_version_id,'document_version',p_version_id,
    'success','READY_FOR_REVIEW',p_correlation_id,jsonb_build_object('hiddenSheetCount',p_hidden_sheet_count));
  DELETE FROM job_queue WHERE job_type = 'document.derivative.cleanup'
    AND payload->>'objectKey' IN
      (SELECT value->>'object_key' FROM jsonb_array_elements(p_derivatives))
    AND state = 'pending';
  DELETE FROM derivative_cleanup_intent
    WHERE version_id = p_version_id AND object_key IN
      (SELECT value->>'object_key' FROM jsonb_array_elements(p_derivatives));
END $$;

CREATE FUNCTION fail_document_processing(
  p_version_id text, p_job_id text, p_lease_owner text, p_lease_token text,
  p_state text, p_kind text, p_code text, p_days integer,
  p_audit_id text, p_correlation_id text, p_retention_job_id text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE retained timestamptz;
BEGIN
  UPDATE document_version v SET state = p_state,failure_kind = p_kind,failure_code = p_code,
    retained_until = transaction_timestamp() + (p_days * interval '1 day'),
    processing_attempts = processing_attempts + 1
  FROM job_queue j WHERE v.id = p_version_id AND v.state = 'quarantine' AND j.id = p_job_id
    AND j.job_type = 'document.source.validate' AND j.payload->>'versionId' = v.id
    AND j.state = 'running' AND j.lease_owner = p_lease_owner AND j.lease_token = p_lease_token
    AND j.lease_expires_at > transaction_timestamp()
  RETURNING v.retained_until INTO retained;
  IF retained IS NULL THEN RAISE EXCEPTION 'job lease lost' USING ERRCODE = '55000'; END IF;
  INSERT INTO job_queue (id,job_type,idempotency_key,payload,available_at)
    VALUES (p_retention_job_id,'document.retention.sweep','retention:' || p_version_id,
      jsonb_build_object('versionId',p_version_id),retained);
  INSERT INTO audit_event
    (id,event_type,actor_kind,subject_id,resource_type,resource_id,result,reason_code,correlation_id)
  VALUES (p_audit_id,'document.processing','system',p_version_id,'document_version',p_version_id,
    'failure',p_code,p_correlation_id);
END $$;

CREATE FUNCTION request_document_processing_retry(
  p_version_id text, p_job_id text, p_audit_id text, p_actor_id text,
  p_room_id text, p_correlation_id text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN
  UPDATE document_version SET state = 'quarantine',manual_retry_count = 1,
    failure_kind = NULL,failure_code = NULL,retained_until = NULL WHERE id = p_version_id
    AND state = 'processing_failed' AND failure_kind = 'transient' AND manual_retry_count = 0;
  IF NOT FOUND THEN RAISE EXCEPTION 'manual retry forbidden' USING ERRCODE = '55000'; END IF;
  INSERT INTO job_queue (id,job_type,idempotency_key,payload)
    VALUES (p_job_id,'document.source.validate','manual-retry:' || p_version_id,
      jsonb_build_object('versionId',p_version_id));
  INSERT INTO audit_event
    (id,event_type,actor_kind,actor_id,subject_id,room_id,resource_type,resource_id,result,reason_code,correlation_id)
  VALUES (p_audit_id,'document.processing.retry','member',p_actor_id,p_version_id,p_room_id,
    'document_version',p_version_id,'success','MANUAL_RETRY_REQUESTED',p_correlation_id);
END $$;

CREATE FUNCTION begin_member_failed_source_deletion(
  p_version_id text, p_actor_id text, p_global_role text, p_audit_id text, p_correlation_id text
) RETURNS TABLE(object_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE current_state text; selected_key text; selected_room text;
BEGIN
  SELECT v.state,v.object_key,d.room_id INTO current_state,selected_key,selected_room
  FROM document_version v JOIN document d ON d.id = v.document_id
  JOIN room r ON r.id = d.room_id AND r.state = 'active'
  LEFT JOIN room_assignment a ON a.room_id = d.room_id AND a.member_id = p_actor_id AND a.state = 'active'
  WHERE v.id = p_version_id
    AND v.state IN ('rejected','processing_failed','malware_quarantined',
      'failed_source_deletion_pending','malware_source_deletion_pending')
    AND (p_global_role IN ('owner','admin') OR a.room_role IN ('manager','contributor'))
  FOR UPDATE OF v;
  IF selected_key IS NULL THEN RAISE EXCEPTION 'failed source delete forbidden' USING ERRCODE = '55000'; END IF;
  IF current_state NOT LIKE '%_deletion_pending' THEN
    UPDATE document_version SET state = CASE WHEN current_state = 'malware_quarantined'
      THEN 'malware_source_deletion_pending' ELSE 'failed_source_deletion_pending' END
      WHERE id = p_version_id;
    INSERT INTO audit_event
      (id,event_type,actor_kind,actor_id,subject_id,room_id,resource_type,resource_id,result,reason_code,correlation_id)
    VALUES (p_audit_id,'document.retention','member',p_actor_id,p_version_id,selected_room,
      'document_version',p_version_id,'success','FAILED_SOURCE_DELETION_PENDING',p_correlation_id);
  END IF;
  RETURN QUERY SELECT selected_key;
END $$;

CREATE FUNCTION finalize_member_failed_source_deletion(
  p_version_id text, p_actor_id text, p_global_role text, p_audit_id text, p_correlation_id text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE selected_room text;
BEGIN
  UPDATE document_version v SET state = CASE WHEN v.state = 'malware_source_deletion_pending'
      THEN 'malware_source_deleted' ELSE 'failed_source_deleted' END
  FROM document d LEFT JOIN room_assignment a ON a.room_id = d.room_id
    AND a.member_id = p_actor_id AND a.state = 'active'
  WHERE v.id = p_version_id AND d.id = v.document_id
    AND v.state IN ('failed_source_deletion_pending','malware_source_deletion_pending')
    AND (p_global_role IN ('owner','admin') OR a.room_role IN ('manager','contributor'))
  RETURNING d.room_id INTO selected_room;
  IF selected_room IS NULL THEN RAISE EXCEPTION 'failed source delete conflict' USING ERRCODE = '55000'; END IF;
  INSERT INTO audit_event
    (id,event_type,actor_kind,actor_id,subject_id,room_id,resource_type,resource_id,result,reason_code,correlation_id)
  VALUES (p_audit_id,'document.retention','member',p_actor_id,p_version_id,selected_room,
    'document_version',p_version_id,'success','FAILED_SOURCE_DELETED_EARLY',p_correlation_id);
END $$;

CREATE FUNCTION begin_retention_deletion(
  p_version_id text, p_job_id text, p_lease_owner text, p_lease_token text,
  p_audit_id text, p_correlation_id text
) RETURNS TABLE(object_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE current_state text; selected_key text;
BEGIN
  SELECT v.state,v.object_key INTO current_state,selected_key FROM document_version v
  JOIN job_queue j ON j.id = p_job_id WHERE v.id = p_version_id
    AND v.state IN ('rejected','processing_failed','malware_quarantined',
      'failed_source_deletion_pending','malware_source_deletion_pending')
    AND (v.retained_until <= transaction_timestamp() OR v.state LIKE '%_deletion_pending')
    AND j.job_type = 'document.retention.sweep' AND j.payload->>'versionId' = v.id
    AND j.state = 'running' AND j.lease_owner = p_lease_owner AND j.lease_token = p_lease_token
    AND j.lease_expires_at > transaction_timestamp() FOR UPDATE OF v;
  IF selected_key IS NULL THEN RETURN; END IF;
  IF current_state NOT LIKE '%_deletion_pending' THEN
    UPDATE document_version SET state = CASE WHEN current_state = 'malware_quarantined'
      THEN 'malware_source_deletion_pending' ELSE 'failed_source_deletion_pending' END
      WHERE id = p_version_id;
    INSERT INTO audit_event
      (id,event_type,actor_kind,subject_id,resource_type,resource_id,result,reason_code,correlation_id)
    VALUES (p_audit_id,'document.retention','system',p_version_id,'document_version',p_version_id,
      'success','FAILED_SOURCE_DELETION_PENDING',p_correlation_id);
  END IF;
  RETURN QUERY SELECT selected_key;
END $$;

CREATE FUNCTION finalize_retention_deletion(
  p_version_id text, p_job_id text, p_lease_owner text, p_lease_token text,
  p_audit_id text, p_correlation_id text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN
  UPDATE document_version v SET state = CASE WHEN v.state = 'malware_source_deletion_pending'
      THEN 'malware_source_deleted' ELSE 'failed_source_deleted' END
  FROM job_queue j WHERE v.id = p_version_id
    AND v.state IN ('failed_source_deletion_pending','malware_source_deletion_pending')
    AND j.id = p_job_id AND j.job_type = 'document.retention.sweep' AND j.payload->>'versionId' = v.id
    AND j.state = 'running' AND j.lease_owner = p_lease_owner AND j.lease_token = p_lease_token
    AND j.lease_expires_at > transaction_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'job lease lost' USING ERRCODE = '55000'; END IF;
  INSERT INTO audit_event
    (id,event_type,actor_kind,subject_id,resource_type,resource_id,result,reason_code,correlation_id)
  VALUES (p_audit_id,'document.retention','system',p_version_id,'document_version',p_version_id,
    'success','FAILED_SOURCE_DELETED',p_correlation_id);
END $$;

REVOKE UPDATE ON document_version FROM duefold_runtime, duefold_worker;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON job_queue FROM duefold_runtime;
/* Derivative rows carry sanitized text layers, accessible labels, and private
 * object keys for every page. A table-wide read let the shared web credential
 * enumerate protected page content with no viewer, session, grant, or
 * publication check -- defeating the viewer-aware delivery boundary the same way
 * the document_version read did. The web role reaches page content only through
 * the digest-bound SECURITY DEFINER delivery functions; credential-free
 * processing legitimately needs these rows. */
GRANT SELECT ON document_derivative, document_scan_evidence, scanner_observation,
  verified_derivative_object, derivative_cleanup_intent TO duefold_worker;
GRANT SELECT ON document_scan_evidence, scanner_observation,
  verified_derivative_object, derivative_cleanup_intent TO duefold_runtime;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON document_derivative, document_scan_evidence,
  scanner_observation, verified_derivative_object, derivative_cleanup_intent FROM duefold_runtime, duefold_worker;

REVOKE ALL ON FUNCTION record_scanner_observation(text,text,text,text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_clean_scan(text,text,text,text,text,timestamptz,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION register_derivative_cleanup(text,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_verified_derivative(text,text,text,text,text,bigint,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_derivative_cleanup(text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accept_processed_version(text,text,text,text,text,text,boolean,jsonb,text,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION fail_document_processing(text,text,text,text,text,text,text,integer,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION request_document_processing_retry(text,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION begin_member_failed_source_deletion(text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION finalize_member_failed_source_deletion(text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION begin_retention_deletion(text,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION finalize_retention_deletion(text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_scanner_observation(text,text,text,text,text,timestamptz),
  record_clean_scan(text,text,text,text,text,timestamptz,text,text),
  register_derivative_cleanup(text,text,text,text,text,text),
  record_verified_derivative(text,text,text,text,text,bigint,text),
  resolve_derivative_cleanup(text,text,text,text),
  accept_processed_version(text,text,text,text,text,text,boolean,jsonb,text,text,integer),
  fail_document_processing(text,text,text,text,text,text,text,integer,text,text,text),
  begin_retention_deletion(text,text,text,text,text,text),
  finalize_retention_deletion(text,text,text,text,text,text) TO duefold_worker;
GRANT EXECUTE ON FUNCTION request_document_processing_retry(text,text,text,text,text,text),
  begin_member_failed_source_deletion(text,text,text,text,text),
  finalize_member_failed_source_deletion(text,text,text,text,text) TO duefold_runtime;

ALTER FUNCTION reject_processing_evidence_mutation() OWNER TO duefold_migration;
ALTER FUNCTION enforce_version_immutability() OWNER TO duefold_migration;
ALTER FUNCTION record_scanner_observation(text,text,text,text,text,timestamptz) OWNER TO duefold_migration;
ALTER FUNCTION record_clean_scan(text,text,text,text,text,timestamptz,text,text) OWNER TO duefold_migration;
ALTER FUNCTION register_derivative_cleanup(text,text,text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION record_verified_derivative(text,text,text,text,text,bigint,text) OWNER TO duefold_migration;
ALTER FUNCTION resolve_derivative_cleanup(text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION accept_processed_version(text,text,text,text,text,text,boolean,jsonb,text,text,integer) OWNER TO duefold_migration;
ALTER FUNCTION fail_document_processing(text,text,text,text,text,text,text,integer,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION request_document_processing_retry(text,text,text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION begin_member_failed_source_deletion(text,text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION finalize_member_failed_source_deletion(text,text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION begin_retention_deletion(text,text,text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION finalize_retention_deletion(text,text,text,text,text,text) OWNER TO duefold_migration;
ALTER TABLE scanner_observation OWNER TO duefold_migration;
ALTER TABLE document_scan_evidence OWNER TO duefold_migration;
ALTER TABLE document_derivative OWNER TO duefold_migration;
ALTER TABLE verified_derivative_object OWNER TO duefold_migration;
ALTER TABLE derivative_cleanup_intent OWNER TO duefold_migration;
GRANT SELECT ON document_version TO duefold_worker;
