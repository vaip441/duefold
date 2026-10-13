-- Work left unfinished by a job that ran out of attempts.

-- A validation job that crashed or threw on every attempt holds no live lease, so
-- fail_document_processing cannot run. The runner calls this in the transaction that
-- marked the job failed, and the version leaves quarantine as a transient failure
-- that Retry accepts. The updated_at fence limits it to that transaction.
CREATE FUNCTION fail_exhausted_document_processing(
  p_job_id text, p_audit_id text, p_correlation_id text, p_retention_job_id text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE failed_version text; retained timestamptz;
BEGIN
  UPDATE document_version v SET state = 'processing_failed',failure_kind = 'transient',
    failure_code = 'PROCESSING_ATTEMPTS_EXHAUSTED',
    retained_until = transaction_timestamp() + interval '7 days',
    processing_attempts = processing_attempts + 1
  FROM job_queue j WHERE j.id = p_job_id AND j.job_type = 'document.source.validate'
    AND j.state = 'failed' AND j.attempts >= j.max_attempts
    AND j.updated_at = transaction_timestamp()
    AND v.id = j.payload->>'versionId' AND v.state = 'quarantine'
  RETURNING v.id,v.retained_until INTO failed_version,retained;
  IF failed_version IS NULL THEN RETURN; END IF;
  PERFORM record_document_processing_failure(failed_version,retained,
    'PROCESSING_ATTEMPTS_EXHAUSTED',p_audit_id,p_correlation_id,p_retention_job_id);
END $$;
REVOKE ALL ON FUNCTION fail_exhausted_document_processing(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fail_exhausted_document_processing(text,text,text,text) TO duefold_worker;
ALTER FUNCTION fail_exhausted_document_processing(text,text,text,text) OWNER TO duefold_migration;

-- Scheduled sweeps used to queue their successor only after a successful run, so a
-- sweep that exhausted its attempts ended its schedule. The runner now queues it when
-- it claims a run; these restart any schedule that has already ended.
INSERT INTO job_queue (id,job_type,idempotency_key,payload,available_at,max_attempts)
SELECT replace(gen_random_uuid()::text,'-',''),s.job_type,s.idempotency_key,'{}'::jsonb,
  statement_timestamp(),10
FROM (VALUES ('export.cleanup','export-cleanup:restart-036'),
  ('status.observe','status-observe:restart-036')) s(job_type,idempotency_key)
WHERE NOT EXISTS (SELECT 1 FROM job_queue j WHERE j.job_type = s.job_type
  AND j.state IN ('pending','running')
  AND NOT (j.state = 'running' AND j.attempts >= j.max_attempts
    AND j.lease_expires_at <= statement_timestamp()));
