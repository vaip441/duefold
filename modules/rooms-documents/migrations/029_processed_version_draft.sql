-- A successfully processed source is the document's reviewed draft version. Keep
-- the published snapshot unchanged, but advance the working revision so publish
-- and later structure mutations observe the worker-created draft change.
CREATE OR REPLACE FUNCTION accept_processed_version(
  p_version_id text, p_job_id text, p_lease_owner text, p_lease_token text,
  p_detected_media_type text, p_sha256 text, p_hidden_sheet_warning boolean,
  p_derivatives jsonb, p_audit_id text, p_correlation_id text, p_hidden_sheet_count integer
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE inserted_count integer; selected_document text; selected_room text; next_working integer;
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
    AND s.version_id = v.id AND s.job_id = p_job_id AND s.lease_token = p_lease_token
  RETURNING v.document_id INTO selected_document;
  IF selected_document IS NULL THEN RAISE EXCEPTION 'document version conflict' USING ERRCODE = '55000'; END IF;
  UPDATE document SET working_version_id=p_version_id,revision=revision+1
    WHERE id=selected_document RETURNING room_id INTO selected_room;
  UPDATE room SET working_revision=working_revision+1
    WHERE id=selected_room AND state<>'archived' RETURNING working_revision INTO next_working;
  IF next_working IS NULL THEN RAISE EXCEPTION 'document room unavailable' USING ERRCODE = '55000'; END IF;
  INSERT INTO audit_event
    (id,event_type,actor_kind,subject_id,room_id,resource_type,resource_id,result,reason_code,correlation_id,detail)
  VALUES (p_audit_id,'document.processing','system',p_version_id,selected_room,'document_version',p_version_id,
    'success','READY_FOR_REVIEW',p_correlation_id,
    jsonb_build_object('hiddenSheetCount',p_hidden_sheet_count,'workingRevision',next_working));
  DELETE FROM job_queue WHERE job_type = 'document.derivative.cleanup'
    AND payload->>'objectKey' IN
      (SELECT value->>'object_key' FROM jsonb_array_elements(p_derivatives))
    AND state = 'pending';
  DELETE FROM derivative_cleanup_intent
    WHERE version_id = p_version_id AND object_key IN
      (SELECT value->>'object_key' FROM jsonb_array_elements(p_derivatives));
END $$;

ALTER FUNCTION accept_processed_version(text,text,text,text,text,text,boolean,jsonb,text,text,integer)
  OWNER TO duefold_migration;

-- Recover only unambiguous legacy documents: exactly one accepted version, real
-- publication evidence, an attached working entry, and no selected draft version.
CREATE TEMP TABLE duefold_recovered_working_version ON COMMIT DROP AS
SELECT d.id AS document_id,d.room_id,min(v.id) AS version_id
FROM document d
JOIN working_structure_entry e ON e.document_id=d.id AND e.room_id=d.room_id
JOIN document_version v ON v.document_id=d.id AND v.state='ready_for_review'
WHERE d.working_version_id IS NULL AND version_has_publication_evidence(v.id,d.id)
GROUP BY d.id,d.room_id
HAVING count(*)=1;

UPDATE document d SET working_version_id=recovered.version_id,revision=d.revision+1
FROM duefold_recovered_working_version recovered WHERE d.id=recovered.document_id;

UPDATE room r SET working_revision=r.working_revision+recovered.count
FROM (
  SELECT room_id,count(*)::integer AS count
  FROM duefold_recovered_working_version GROUP BY room_id
) recovered WHERE r.id=recovered.room_id;

INSERT INTO audit_event(
  id,event_type,actor_kind,subject_id,room_id,resource_type,resource_id,
  result,reason_code,correlation_id,detail
)
SELECT md5('working-version-recovered:'||recovered.document_id),'document.processing','system',
  recovered.version_id,recovered.room_id,'document_version',recovered.version_id,
  'success','READY_VERSION_ATTACHED','corr_'||md5('working-version-recovery-correlation:'||recovered.document_id),
  jsonb_build_object('documentId',recovered.document_id)
FROM duefold_recovered_working_version recovered;
