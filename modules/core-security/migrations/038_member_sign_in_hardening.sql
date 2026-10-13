-- Bind each OIDC transaction to the browser that began it (login CSRF).

-- Transactions in flight at upgrade carry no binding and could only be completed
-- unbound; they live ten minutes, so the affected sign-ins simply start again.
DELETE FROM oidc_transaction;
ALTER TABLE oidc_transaction ADD COLUMN browser_binding_digest char(64) NOT NULL;
-- Every public begin purges expired rows; keep that a range scan as the table grows.
CREATE INDEX oidc_transaction_expires_at ON oidc_transaction (expires_at);
-- Begin is public, so each network may hold only a bounded number of live transactions.
ALTER TABLE oidc_transaction ADD COLUMN network_hmac char(64) NOT NULL;
CREATE INDEX oidc_transaction_network_hmac ON oidc_transaction (network_hmac);

-- The runner's exhaustion hook for OTP delivery, called in the transaction that failed the
-- job after its last attempt, so the challenge stops waiting for a code that never comes.
-- The updated_at fence limits it to that transaction.
CREATE FUNCTION fail_exhausted_otp_delivery(
  p_job_id text, p_audit_id text, p_correlation_id text, p_follow_up_job_id text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE invalidated text;
BEGIN
  UPDATE otp_challenge o SET state = 'invalidated'
  FROM job_queue j WHERE j.id = p_job_id AND j.job_type = 'auth.otp.deliver'
    AND j.state = 'failed' AND j.attempts >= j.max_attempts
    AND j.updated_at = transaction_timestamp()
    AND o.id = j.payload->>'challengeId' AND o.state IN ('awaiting_delivery','pending')
  RETURNING o.id INTO invalidated;
  IF invalidated IS NULL THEN RETURN; END IF;
  INSERT INTO audit_event (id,event_type,actor_kind,subject_id,result,reason_code,correlation_id)
  VALUES (p_audit_id,'auth.otp','system',invalidated,'failure','OTP_DELIVERY_FAILED',p_correlation_id);
END $$;
REVOKE ALL ON FUNCTION fail_exhausted_otp_delivery(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fail_exhausted_otp_delivery(text,text,text,text) TO duefold_worker;
ALTER FUNCTION fail_exhausted_otp_delivery(text,text,text,text) OWNER TO duefold_migration;

-- The ownership-preview sweep used to queue its successor only after a successful run,
-- so a run that exhausted its attempts ended the schedule. The runner now queues it when
-- it claims a run; this restarts a schedule that has already ended.
INSERT INTO job_queue (id,job_type,idempotency_key,payload,available_at,max_attempts)
SELECT replace(gen_random_uuid()::text,'-',''),'ownership.preview.purge',
  'ownership-preview-purge:restart-038','{}'::jsonb,statement_timestamp(),10
WHERE NOT EXISTS (SELECT 1 FROM job_queue j WHERE j.job_type = 'ownership.preview.purge'
  AND j.state IN ('pending','running')
  AND NOT (j.state = 'running' AND j.attempts >= j.max_attempts
    AND j.lease_expires_at <= statement_timestamp()));

-- A job whose exhaustion hook keeps raising stays 'running' with an expired lease while the
-- runner retries the hook. Report it with the failures rather than as work in progress.
CREATE OR REPLACE FUNCTION read_deployment_status(p_actor_id text)
RETURNS TABLE(applied_migrations text[],jobs_due integer,jobs_running integer,
              jobs_failed_recently integer,oldest_due_seconds integer,
              mail_delivered_at timestamptz,mail_failed_recently integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  mail_jobs constant text[] := ARRAY['auth.otp.deliver','mail.viewer_invitation','mail.member_invitation'];
  window_start constant timestamptz := statement_timestamp()-interval '7 days';
BEGIN
  PERFORM assert_organization_administrator(p_actor_id);
  RETURN QUERY
    WITH failed AS (
      SELECT j.job_type FROM job_queue j
       WHERE (j.state='failed'
              OR (j.state='running' AND j.last_error_code='EXHAUSTION_HOOK_FAILED'))
         AND j.updated_at>window_start
    )
    SELECT
      ARRAY(SELECT a.id FROM read_applied_migration_ids() a),
      (SELECT count(*)::integer FROM job_queue j
        WHERE j.state='pending' AND j.available_at<=statement_timestamp()),
      (SELECT count(*)::integer FROM job_queue j
        WHERE j.state='running' AND j.last_error_code IS DISTINCT FROM 'EXHAUSTION_HOOK_FAILED'),
      (SELECT count(*)::integer FROM failed),
      (SELECT floor(extract(epoch FROM statement_timestamp()-min(j.available_at)))::integer
         FROM job_queue j WHERE j.state='pending' AND j.available_at<=statement_timestamp()),
      (SELECT max(j.updated_at) FROM job_queue j
        WHERE j.state='succeeded' AND j.job_type=ANY(mail_jobs)),
      (SELECT count(*)::integer FROM failed f WHERE f.job_type=ANY(mail_jobs));
END $$;
