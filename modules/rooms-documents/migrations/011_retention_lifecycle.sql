-- Prospective audit retention, keyed viewer pseudonyms,
-- fixed-delay whole-room purge, and operator-owned recovery evidence.

ALTER TABLE room ADD COLUMN audit_retention_years smallint NOT NULL DEFAULT 7
  CHECK (audit_retention_years BETWEEN 1 AND 10);
ALTER TABLE audit_event ADD COLUMN retain_until timestamptz;
/* One-time migration backfill for pre-011 rows. The migration runner applies the
 * file in one transaction as duefold_migration; runtime/worker cannot disable
 * this trigger or mutate audit rows. Re-enable immediately so append-only
 * behavior remains in force before the migration commits. */
ALTER TABLE audit_event DISABLE TRIGGER audit_event_append_only;
UPDATE audit_event SET retain_until=occurred_at+interval '7 years' WHERE retain_until IS NULL;
ALTER TABLE audit_event ENABLE TRIGGER audit_event_append_only;
ALTER TABLE audit_event ALTER COLUMN retain_until SET NOT NULL;
ALTER TABLE audit_event ALTER COLUMN retain_until
  SET DEFAULT (transaction_timestamp()+interval '7 years');

CREATE FUNCTION assign_audit_retention() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE years smallint;
BEGIN
  SELECT audit_retention_years INTO years FROM room WHERE id=NEW.room_id;
  years:=COALESCE(years,7);
  -- Caller-supplied retention is never trusted. The event keeps the room policy
  -- in force at INSERT time, so later policy changes cannot shorten it.
  NEW.retain_until:=NEW.occurred_at+make_interval(years=>years);
  RETURN NEW;
END $$;
CREATE TRIGGER audit_retention_at_insert BEFORE INSERT ON audit_event
FOR EACH ROW EXECUTE FUNCTION assign_audit_retention();

CREATE FUNCTION dry_run_audit_retention(p_actor_id text,p_room_id text,p_years integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE title text; current_years smallint;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM member WHERE id=p_actor_id AND state='active' AND global_role='owner') THEN
    RAISE EXCEPTION 'owner required' USING ERRCODE='42501';
  END IF;
  IF p_years NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION 'retention out of range' USING ERRCODE='22023'; END IF;
  SELECT r.title,r.audit_retention_years INTO title,current_years FROM room r
    WHERE r.id=p_room_id AND r.state='draft';
  IF title IS NULL THEN RAISE EXCEPTION 'retention locks at publication' USING ERRCODE='55000'; END IF;
  RETURN jsonb_build_object('roomId',p_room_id,'currentYears',current_years,'proposedYears',p_years,
    'existingAuditRowsUnaffected',true,'confirmation','SET AUDIT RETENTION TO '||p_years||' YEARS');
END $$;

CREATE FUNCTION apply_audit_retention(p_actor_id text,p_room_id text,p_years integer,
  p_oidc_authenticated_at timestamptz,p_expected_revision integer,p_confirmation text,
  p_audit_id text,p_correlation_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE impact jsonb; next_revision integer;
BEGIN
  IF p_oidc_authenticated_at IS NULL OR p_oidc_authenticated_at>statement_timestamp()
     OR p_oidc_authenticated_at<=statement_timestamp()-interval '15 minutes' THEN
    RAISE EXCEPTION 'fresh OIDC required' USING ERRCODE='42501';
  END IF;
  impact:=dry_run_audit_retention(p_actor_id,p_room_id,p_years);
  IF p_confirmation IS DISTINCT FROM impact->>'confirmation' THEN
    RAISE EXCEPTION 'typed confirmation mismatch' USING ERRCODE='22023';
  END IF;
  UPDATE room SET audit_retention_years=p_years,revision=revision+1
    WHERE id=p_room_id AND state='draft' AND revision=p_expected_revision
    RETURNING revision INTO next_revision;
  IF next_revision IS NULL THEN RAISE EXCEPTION 'room revision conflict or retention locked' USING ERRCODE='40001'; END IF;
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,
    result,reason_code,correlation_id,detail)
  VALUES(p_audit_id,'audit.retention','member',p_actor_id,p_room_id,'room',p_room_id,
    'success','RETENTION_CHANGED',p_correlation_id,jsonb_build_object('years',p_years,'prospective',true));
  RETURN impact||jsonb_build_object('revision',next_revision);
END $$;

CREATE TABLE viewer_pseudonym (
  viewer_id text NOT NULL REFERENCES viewer(id),
  evidence_reference text NOT NULL UNIQUE CHECK (evidence_reference ~ '^vref_[a-f0-9]{64}$'),
  scope text NOT NULL CHECK (scope ~ '^room:[A-Za-z0-9_-]{32}$'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY(viewer_id,scope)
);
COMMENT ON TABLE viewer_pseudonym IS
  'Stable keyed evidence reference. Key material is supplied only to the worker from DUEFOLD_PII_HMAC_KEY and is never stored in PostgreSQL.';

CREATE TABLE room_purge (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{32}$'),
  room_id text NOT NULL UNIQUE CHECK (room_id ~ '^[A-Za-z0-9_-]{32}$'),
  state text NOT NULL DEFAULT 'scheduled' CHECK (state IN ('scheduled','cancelled','marker_pending','purging','purged','failed')),
  scheduled_by text NOT NULL REFERENCES member(id),
  scheduled_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  purge_after timestamptz NOT NULL,
  marker_key text NOT NULL UNIQUE CHECK (marker_key ~ '^system/deletion-markers/v1/[A-Za-z0-9_-]{32}/[A-Za-z0-9_-]{32}\.json$'),
  marker_written_at timestamptz,
  marker_reconciled_at timestamptz,
  cancelled_at timestamptz,
  purged_at timestamptz,
  CHECK (purge_after=scheduled_at+interval '30 days'),
  CHECK ((state='cancelled')=(cancelled_at IS NOT NULL)),
  CHECK ((state='purged')=(purged_at IS NOT NULL))
);
CREATE INDEX room_purge_due ON room_purge(purge_after) WHERE state='scheduled';

CREATE TABLE operational_recovery_status (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  backup_status text NOT NULL DEFAULT 'undetermined' CHECK (backup_status IN ('undetermined','operator-acknowledged')),
  backup_retention text,
  recovery_expectation text,
  acknowledged_at timestamptz,
  restore_drill_status text NOT NULL DEFAULT 'not-tested' CHECK (restore_drill_status IN ('not-tested','passed','failed')),
  restore_drill_at timestamptz,
  restore_drill_detail text CHECK (restore_drill_detail IS NULL OR length(restore_drill_detail)<=500)
);
INSERT INTO operational_recovery_status(singleton) VALUES(true);

CREATE FUNCTION dry_run_room_purge(p_actor_id text,p_room_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE impact jsonb;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM member WHERE id=p_actor_id AND state='active' AND global_role='owner') THEN
    RAISE EXCEPTION 'owner required' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM room WHERE id=p_room_id AND state='archived') THEN
    RAISE EXCEPTION 'room must be archived' USING ERRCODE='55000';
  END IF;
  SELECT jsonb_build_object('roomId',p_room_id,'documentCount',(SELECT count(*) FROM document WHERE room_id=p_room_id),
    'viewerCount',(SELECT count(*) FROM viewer_room_membership WHERE room_id=p_room_id),
    'sourceBytes',(SELECT COALESCE(sum(v.size_bytes),0) FROM document d JOIN document_version v ON v.document_id=d.id WHERE d.room_id=p_room_id),
    'cancellationDays',30,'confirmation','SCHEDULE PURGE FOR ROOM '||p_room_id) INTO impact;
  RETURN impact;
END $$;

CREATE FUNCTION schedule_room_purge(p_id text,p_actor_id text,p_room_id text,
  p_oidc_authenticated_at timestamptz,p_expected_revision integer,p_confirmation text,p_marker_key text,
  p_job_id text,p_audit_id text,p_correlation_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE impact jsonb; due timestamptz;
BEGIN
  IF p_oidc_authenticated_at IS NULL OR p_oidc_authenticated_at>statement_timestamp()
     OR p_oidc_authenticated_at<=statement_timestamp()-interval '15 minutes' THEN
    RAISE EXCEPTION 'fresh OIDC required' USING ERRCODE='42501';
  END IF;
  impact:=dry_run_room_purge(p_actor_id,p_room_id);
  IF p_confirmation IS DISTINCT FROM impact->>'confirmation' THEN
    RAISE EXCEPTION 'typed confirmation mismatch' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM room WHERE id=p_room_id AND state='archived' AND revision=p_expected_revision FOR UPDATE) THEN
    RAISE EXCEPTION 'room revision conflict' USING ERRCODE='40001';
  END IF;
  due:=statement_timestamp()+interval '30 days';
  INSERT INTO room_purge(id,room_id,scheduled_by,purge_after,marker_key)
    VALUES(p_id,p_room_id,p_actor_id,due,p_marker_key);
  INSERT INTO job_queue(id,job_type,idempotency_key,payload,available_at,max_attempts)
    VALUES(p_job_id,'room.whole.purge','whole-room-purge:'||p_id,jsonb_build_object('purgeId',p_id),due,10);
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,
    result,reason_code,correlation_id,detail)
  VALUES(p_audit_id,'room.purge','member',p_actor_id,p_room_id,'room_purge',p_id,
    'success','PURGE_SCHEDULED',p_correlation_id,jsonb_build_object('purgeAfter',due,'cancellationDays',30));
  RETURN impact||jsonb_build_object('purgeId',p_id,'purgeAfter',due);
END $$;

CREATE FUNCTION cancel_room_purge(p_purge_id text,p_actor_id text,p_confirmation text,
  p_audit_id text,p_correlation_id text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected_room text;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM member WHERE id=p_actor_id AND state='active' AND global_role='owner') THEN
    RAISE EXCEPTION 'owner required' USING ERRCODE='42501';
  END IF;
  IF p_confirmation IS DISTINCT FROM 'CANCEL ROOM PURGE' THEN
    RAISE EXCEPTION 'typed confirmation mismatch' USING ERRCODE='22023';
  END IF;
  UPDATE room_purge SET state='cancelled',cancelled_at=statement_timestamp()
    WHERE id=p_purge_id AND state='scheduled' AND purge_after>statement_timestamp()
    RETURNING room_id INTO selected_room;
  IF selected_room IS NULL THEN RAISE EXCEPTION 'purge cannot be cancelled' USING ERRCODE='55000'; END IF;
  DELETE FROM job_queue WHERE id=(SELECT id FROM job_queue WHERE job_type='room.whole.purge' AND payload->>'purgeId'=p_purge_id
      AND state='pending') AND state='pending';
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,
    result,reason_code,correlation_id)
  VALUES(p_audit_id,'room.purge','member',p_actor_id,selected_room,'room_purge',p_purge_id,
    'success','PURGE_CANCELLED',p_correlation_id);
  RETURN true;
END $$;

CREATE FUNCTION begin_room_purge(p_purge_id text,p_job_id text,p_owner text,p_token text)
RETURNS TABLE(marker_key text,room_id text)
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  UPDATE room_purge p SET state=CASE WHEN p.state='scheduled' THEN 'marker_pending' ELSE p.state END
  FROM job_queue j WHERE p.id=p_purge_id AND p.state IN ('scheduled','marker_pending','purging')
    AND p.purge_after<=statement_timestamp() AND j.id=p_job_id
    AND j.job_type='room.whole.purge' AND j.payload->>'purgeId'=p.id
    AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token
    AND j.lease_expires_at>statement_timestamp()
  RETURNING p.marker_key,p.room_id
$$;

CREATE FUNCTION mark_room_purge_marker_written(p_purge_id text,p_job_id text,p_owner text,p_token text)
RETURNS TABLE(object_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected_room text;
BEGIN
  UPDATE room_purge p SET state='purging',marker_written_at=COALESCE(p.marker_written_at,statement_timestamp())
  FROM job_queue j WHERE p.id=p_purge_id AND p.state IN ('marker_pending','purging') AND j.id=p_job_id
    AND j.job_type='room.whole.purge' AND j.payload->>'purgeId'=p.id
    AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token
    AND j.lease_expires_at>statement_timestamp() RETURNING p.room_id INTO selected_room;
  IF selected_room IS NULL THEN RAISE EXCEPTION 'purge lease lost' USING ERRCODE='55000'; END IF;
  RETURN QUERY
    SELECT v.object_key FROM document d JOIN document_version v ON v.document_id=d.id WHERE d.room_id=selected_room
    UNION SELECT x.object_key FROM document d JOIN document_version v ON v.document_id=d.id JOIN document_derivative x ON x.version_id=v.id WHERE d.room_id=selected_room
    UNION SELECT x.object_key FROM document d JOIN document_version v ON v.document_id=d.id JOIN verified_derivative_object x ON x.version_id=v.id WHERE d.room_id=selected_room
    UNION SELECT x.object_key FROM document d JOIN document_version v ON v.document_id=d.id JOIN derivative_cleanup_intent x ON x.version_id=v.id WHERE d.room_id=selected_room
    UNION SELECT u.object_key FROM upload_intent u WHERE u.room_id=selected_room
    UNION SELECT w.object_key FROM watermark_cache w WHERE w.room_id=selected_room
    UNION SELECT e.object_key FROM export_request e WHERE e.room_id=selected_room;
END $$;

CREATE FUNCTION read_room_purge_viewers(p_purge_id text,p_job_id text,p_owner text,p_token text)
RETURNS TABLE(viewer_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT m.viewer_id FROM room_purge p JOIN viewer_room_membership m ON m.room_id=p.room_id
  JOIN job_queue j ON j.id=p_job_id WHERE p.id=p_purge_id AND p.state='purging'
    AND p.marker_written_at IS NOT NULL AND j.job_type='room.whole.purge'
    AND j.payload->>'purgeId'=p.id AND j.state='running' AND j.lease_owner=p_owner
    AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp() ORDER BY m.viewer_id
$$;

CREATE FUNCTION finalize_room_purge(p_purge_id text,p_job_id text,p_owner text,p_token text,
  p_pseudonyms jsonb,p_audit_id text,p_correlation_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected_room text; viewer_ids text[]; document_ids text[]; version_ids text[]; item jsonb; affected integer;
BEGIN
  SELECT p.room_id INTO selected_room FROM room_purge p JOIN job_queue j ON j.id=p_job_id
    WHERE p.id=p_purge_id AND p.state='purging' AND p.marker_written_at IS NOT NULL
      AND j.job_type='room.whole.purge' AND j.payload->>'purgeId'=p.id AND j.state='running'
      AND j.lease_owner=p_owner AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp()
    FOR UPDATE OF p,j;
  IF selected_room IS NULL THEN RAISE EXCEPTION 'purge lease lost or marker absent' USING ERRCODE='55000'; END IF;
  SELECT COALESCE(array_agg(viewer_id),'{}') INTO viewer_ids FROM viewer_room_membership WHERE room_id=selected_room;
  SELECT COALESCE(array_agg(id),'{}') INTO document_ids FROM document WHERE room_id=selected_room;
  SELECT COALESCE(array_agg(id),'{}') INTO version_ids FROM document_version WHERE document_id=ANY(document_ids);
  IF jsonb_typeof(p_pseudonyms)<>'array' OR jsonb_array_length(p_pseudonyms)<>cardinality(viewer_ids)
     OR (SELECT count(DISTINCT value->>'viewerId') FROM jsonb_array_elements(p_pseudonyms))<>cardinality(viewer_ids)
     OR EXISTS(SELECT 1 FROM unnest(viewer_ids) expected
       WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_pseudonyms) AS supplied(value)
         WHERE supplied.value->>'viewerId'=expected)) THEN
    RAISE EXCEPTION 'pseudonym manifest mismatch' USING ERRCODE='22023';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_pseudonyms) LOOP
    IF NOT ((item->>'viewerId')=ANY(viewer_ids)) OR (item->>'reference') !~ '^vref_[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'pseudonym manifest invalid' USING ERRCODE='22023';
    END IF;
    INSERT INTO viewer_pseudonym(viewer_id,evidence_reference,scope)
      SELECT item->>'viewerId',item->>'reference','room:'||selected_room FROM job_queue j
      WHERE j.id=p_job_id AND j.state='running' AND j.lease_owner=p_owner
        AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp()
      ON CONFLICT(viewer_id,scope) DO UPDATE SET evidence_reference=EXCLUDED.evidence_reference;
    IF NOT FOUND THEN RAISE EXCEPTION 'purge lease lost' USING ERRCODE='55000'; END IF;
  END LOOP;
  -- Every mutation below repeats the live lease predicate. This is intentional:
  -- the lease may expire between statements and no later destructive statement
  -- may continue merely because the function once held it.
  DELETE FROM preview_delivery_telemetry x USING preview_activity a,job_queue j WHERE x.activity_id=a.id AND a.room_id=selected_room AND j.id=p_job_id AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp();
  DELETE FROM preview_activity x USING job_queue j WHERE x.room_id=selected_room AND j.id=p_job_id AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp();
  DELETE FROM download_lease x USING job_queue j WHERE x.room_id=selected_room AND j.id=p_job_id AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp();
  DELETE FROM watermark_cache x USING job_queue j WHERE x.room_id=selected_room AND j.id=p_job_id AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp();
  DELETE FROM export_request x USING job_queue j WHERE x.room_id=selected_room AND j.id=p_job_id AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp();
  DELETE FROM counterparty_viewer x USING job_queue j WHERE x.room_id=selected_room AND j.id=p_job_id AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp();
  DELETE FROM access_grant x USING job_queue j WHERE x.room_id=selected_room AND j.id=p_job_id AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp();
  DELETE FROM counterparty x USING job_queue j WHERE x.room_id=selected_room AND j.id=p_job_id AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp();
  DELETE FROM viewer_room_membership x USING job_queue j WHERE x.room_id=selected_room AND j.id=p_job_id AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp();
  DELETE FROM room_assignment x USING job_queue j WHERE x.room_id=selected_room AND j.id=p_job_id AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp();
  DELETE FROM published_structure_entry x USING job_queue j WHERE x.room_id=selected_room AND j.id=p_job_id AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp();
  DELETE FROM room_trash x USING job_queue j WHERE x.room_id=selected_room AND j.id=p_job_id AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp();
  DELETE FROM working_structure_entry x USING job_queue j WHERE x.room_id=selected_room AND j.id=p_job_id AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp();
  DELETE FROM verified_derivative_object x USING job_queue j WHERE x.version_id=ANY(version_ids) AND j.id=p_job_id AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp();
  DELETE FROM derivative_cleanup_intent x USING job_queue j WHERE x.version_id=ANY(version_ids) AND j.id=p_job_id AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp();
  DELETE FROM document_derivative x USING job_queue j WHERE x.version_id=ANY(version_ids) AND j.id=p_job_id AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp();
  DELETE FROM document_scan_evidence x USING job_queue j WHERE x.version_id=ANY(version_ids) AND j.id=p_job_id AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp();
  DELETE FROM scanner_observation x USING job_queue j WHERE x.version_id=ANY(version_ids) AND j.id=p_job_id AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp();
  DELETE FROM upload_intent x USING job_queue j WHERE x.room_id=selected_room AND j.id=p_job_id AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp();
  DELETE FROM session x USING job_queue j WHERE x.viewer_id=ANY(viewer_ids) AND NOT EXISTS(SELECT 1 FROM viewer_room_membership m WHERE m.viewer_id=x.viewer_id) AND j.id=p_job_id AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp();
  DELETE FROM otp_challenge x USING job_queue j WHERE x.viewer_id=ANY(viewer_ids) AND NOT EXISTS(SELECT 1 FROM viewer_room_membership m WHERE m.viewer_id=x.viewer_id) AND j.id=p_job_id AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp();
  DELETE FROM invitation x USING job_queue j WHERE x.kind='viewer' AND x.email_key=ANY(ARRAY(SELECT v.email_key FROM viewer v WHERE v.id=ANY(viewer_ids) AND NOT EXISTS(SELECT 1 FROM viewer_room_membership m WHERE m.viewer_id=v.id))) AND j.id=p_job_id AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp();
  UPDATE document x SET working_version_id=NULL FROM job_queue j WHERE x.id=ANY(document_ids) AND j.id=p_job_id AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp();
  DELETE FROM document_version x USING job_queue j WHERE x.id=ANY(version_ids) AND j.id=p_job_id AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp();
  DELETE FROM document x USING job_queue j WHERE x.id=ANY(document_ids) AND j.id=p_job_id AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp();
  DELETE FROM folder x USING job_queue j WHERE x.room_id=selected_room AND j.id=p_job_id AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp();
  UPDATE viewer v SET state='anonymized',email_key='anon-'||md5(v.id)||'@invalid.example',email_display='anonymized@invalid.example',revision=revision+1 FROM job_queue j WHERE v.id=ANY(viewer_ids) AND NOT EXISTS(SELECT 1 FROM viewer_room_membership m WHERE m.viewer_id=v.id) AND j.id=p_job_id AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp();
  INSERT INTO audit_event(id,event_type,actor_kind,room_id,resource_type,resource_id,result,reason_code,correlation_id,detail)
  SELECT p_audit_id,'room.purge','system',selected_room,'room_purge',p_purge_id,'success','ROOM_PURGED',p_correlation_id,
    jsonb_build_object('viewerEvidenceReferences',(SELECT jsonb_agg(value->>'reference' ORDER BY value->>'reference') FROM jsonb_array_elements(p_pseudonyms)))
  FROM job_queue j WHERE j.id=p_job_id AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'purge lease lost' USING ERRCODE='55000'; END IF;
  DELETE FROM room x USING job_queue j WHERE x.id=selected_room AND j.id=p_job_id AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp();
  UPDATE room_purge p SET state='purged',purged_at=statement_timestamp() FROM job_queue j WHERE p.id=p_purge_id AND p.state='purging' AND j.id=p_job_id AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp();
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected<>1 THEN RAISE EXCEPTION 'purge lease lost' USING ERRCODE='55000'; END IF;
END $$;

CREATE FUNCTION unreconciled_deletion_markers() RETURNS TABLE(purge_id text,marker_key text,room_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT id,marker_key,room_id FROM room_purge
  WHERE marker_written_at IS NOT NULL AND marker_reconciled_at IS NULL AND state IN ('purging','purged')
  ORDER BY id
$$;
CREATE FUNCTION record_restore_drill_result(p_status text,p_detail text,p_audit_id text,p_correlation_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF p_status NOT IN ('passed','failed') OR length(p_detail)>500 THEN
    RAISE EXCEPTION 'restore drill result invalid' USING ERRCODE='22023';
  END IF;
  UPDATE operational_recovery_status SET restore_drill_status=p_status,
    restore_drill_at=statement_timestamp(),restore_drill_detail=p_detail WHERE singleton;
  INSERT INTO audit_event(id,event_type,actor_kind,resource_type,resource_id,result,
    reason_code,correlation_id,detail)
  VALUES(p_audit_id,'recovery.restore_drill','system','installation','restore-drill',
    CASE WHEN p_status='passed' THEN 'success' ELSE 'failure' END,
    CASE WHEN p_status='passed' THEN 'RESTORE_DRILL_PASSED' ELSE 'RESTORE_DRILL_NOT_PASSED' END,
    p_correlation_id,jsonb_build_object('status',p_status));
  RETURN true;
END $$;

CREATE FUNCTION reconcile_deletion_marker(p_purge_id text,p_marker_key text,
  p_audit_id text,p_correlation_id text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected_room text;
BEGIN
  UPDATE room_purge p SET marker_reconciled_at=statement_timestamp()
  WHERE p.id=p_purge_id AND p.marker_key=p_marker_key AND p.marker_written_at IS NOT NULL
    AND p.marker_reconciled_at IS NULL AND p.state='purged'
    AND NOT EXISTS(SELECT 1 FROM room r WHERE r.id=p.room_id)
  RETURNING p.room_id INTO selected_room;
  IF selected_room IS NULL THEN RETURN false; END IF;
  INSERT INTO audit_event(id,event_type,actor_kind,resource_type,resource_id,result,
    reason_code,correlation_id)
  VALUES(p_audit_id,'recovery.deletion_marker','system','room_purge',p_purge_id,
    'success','DELETION_MARKER_RECONCILED',p_correlation_id);
  RETURN true;
END $$;

ALTER TABLE viewer_pseudonym OWNER TO duefold_migration;
ALTER TABLE room_purge OWNER TO duefold_migration;
ALTER TABLE operational_recovery_status OWNER TO duefold_migration;
REVOKE ALL ON viewer_pseudonym,room_purge,operational_recovery_status FROM PUBLIC,duefold_runtime,duefold_authenticator,duefold_worker;
REVOKE ALL ON FUNCTION dry_run_audit_retention(text,text,integer),apply_audit_retention(text,text,integer,timestamptz,integer,text,text,text),dry_run_room_purge(text,text),schedule_room_purge(text,text,text,timestamptz,integer,text,text,text,text,text),cancel_room_purge(text,text,text,text,text),begin_room_purge(text,text,text,text),mark_room_purge_marker_written(text,text,text,text),read_room_purge_viewers(text,text,text,text),finalize_room_purge(text,text,text,text,jsonb,text,text),unreconciled_deletion_markers(),record_restore_drill_result(text,text,text,text),reconcile_deletion_marker(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dry_run_audit_retention(text,text,integer),apply_audit_retention(text,text,integer,timestamptz,integer,text,text,text),dry_run_room_purge(text,text),schedule_room_purge(text,text,text,timestamptz,integer,text,text,text,text,text),cancel_room_purge(text,text,text,text,text) TO duefold_runtime;
GRANT EXECUTE ON FUNCTION begin_room_purge(text,text,text,text),mark_room_purge_marker_written(text,text,text,text),read_room_purge_viewers(text,text,text,text),finalize_room_purge(text,text,text,text,jsonb,text,text) TO duefold_worker;
GRANT EXECUTE ON FUNCTION unreconciled_deletion_markers(),record_restore_drill_result(text,text,text,text),reconcile_deletion_marker(text,text,text,text) TO duefold_migration;

ALTER FUNCTION assign_audit_retention() OWNER TO duefold_migration;
ALTER FUNCTION dry_run_audit_retention(text,text,integer) OWNER TO duefold_migration;
ALTER FUNCTION apply_audit_retention(text,text,integer,timestamptz,integer,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION dry_run_room_purge(text,text) OWNER TO duefold_migration;
ALTER FUNCTION schedule_room_purge(text,text,text,timestamptz,integer,text,text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION cancel_room_purge(text,text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION begin_room_purge(text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION mark_room_purge_marker_written(text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION read_room_purge_viewers(text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION finalize_room_purge(text,text,text,text,jsonb,text,text) OWNER TO duefold_migration;
ALTER FUNCTION unreconciled_deletion_markers() OWNER TO duefold_migration;
ALTER FUNCTION record_restore_drill_result(text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION reconcile_deletion_marker(text,text,text,text) OWNER TO duefold_migration;
