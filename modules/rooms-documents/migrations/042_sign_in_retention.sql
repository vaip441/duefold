-- Ended sign-in codes and sessions are deleted 30 days after they end; audit keeps
-- the record. Lives here, not in core-security, because a session may be deleted only
-- once the rooms-documents rows that cascade from it hold nothing still owed.

-- Each deleted session probes and cascades into these tables by session_id.
CREATE INDEX preview_activity_session ON preview_activity(session_id);
CREATE INDEX download_lease_session ON download_lease(session_id);
CREATE INDEX watermark_cache_session ON watermark_cache(session_id);

CREATE FUNCTION purge_ended_sign_in(p_job_id text,p_owner text,p_token text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM 1 FROM job_queue j WHERE j.id=p_job_id AND j.job_type='sign_in.retention.sweep'
    AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token
    AND j.lease_expires_at>statement_timestamp()
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'sign-in retention lease lost' USING ERRCODE='55000'; END IF;
  -- A code can no longer be used after expires_at; one that never received a digest was
  -- never usable and is dated by creation. The delivery job treats a missing row as done.
  DELETE FROM otp_challenge
    WHERE COALESCE(expires_at,created_at)<statement_timestamp()-interval '30 days';
  -- idle_expires_at is renewed only while a session is active, so it bounds when any
  -- session ended, whether it expired, rotated, or was revoked. Deleting cascades to
  -- preview activity, download leases, and watermark cache rows: wait until each
  -- preview and download has written its audit summary and each cached page object
  -- has been deleted from storage, so no evidence or object is orphaned.
  DELETE FROM session s
    WHERE s.idle_expires_at<statement_timestamp()-interval '30 days'
      AND NOT EXISTS(SELECT 1 FROM preview_activity a WHERE a.session_id=s.id AND a.state='active')
      AND NOT EXISTS(SELECT 1 FROM download_lease l WHERE l.session_id=s.id AND l.state='active')
      AND NOT EXISTS(SELECT 1 FROM watermark_cache w WHERE w.session_id=s.id AND w.state<>'deleted');
END $$;
REVOKE ALL ON FUNCTION purge_ended_sign_in(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_ended_sign_in(text,text,text) TO duefold_worker;
ALTER FUNCTION purge_ended_sign_in(text,text,text) OWNER TO duefold_migration;

-- Seeded once and due a day after migration; the runner queues each next run.
INSERT INTO job_queue(id,job_type,idempotency_key,payload,available_at,max_attempts)
VALUES(replace(gen_random_uuid()::text,'-',''),'sign_in.retention.sweep','sign-in-retention:initial',
       '{}'::jsonb,statement_timestamp()+interval '1 day',10);
