-- Audit rows are deleted once their retain_until has passed (§15.4); until then they stay
-- append-only for every role.

CREATE INDEX audit_event_retain_until ON audit_event(retain_until);

/* Any role may set the flag, so it is honoured only for the owner (runtime roles hold no
 * DELETE anyway); purge_expired_audit_events sets it around its one DELETE. Rows not yet
 * expired stay refused even then. */
CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' AND current_user='duefold_migration'
     AND current_setting('duefold.audit_retention_sweep',true)='on'
     AND OLD.retain_until<statement_timestamp() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_event is append-only' USING ERRCODE = '55000';
END $$;

CREATE FUNCTION purge_expired_audit_events(p_job_id text,p_owner text,p_token text,
  p_audit_id text,p_correlation_id text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE deleted integer;
BEGIN
  PERFORM 1 FROM job_queue j WHERE j.id=p_job_id AND j.job_type='audit.retention.sweep'
    AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token
    AND j.lease_expires_at>statement_timestamp()
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'audit retention lease lost' USING ERRCODE='55000'; END IF;
  PERFORM set_config('duefold.audit_retention_sweep','on',true);
  DELETE FROM audit_event WHERE sequence IN (
    SELECT sequence FROM audit_event WHERE retain_until<statement_timestamp()
    ORDER BY retain_until LIMIT 1000);
  GET DIAGNOSTICS deleted=ROW_COUNT;
  PERFORM set_config('duefold.audit_retention_sweep','off',true);
  IF deleted>0 THEN
    INSERT INTO audit_event(id,event_type,actor_kind,resource_type,resource_id,result,
      reason_code,correlation_id,detail)
    VALUES(p_audit_id,'audit.retention','system','installation','audit-retention','success',
      'EXPIRED_AUDIT_DELETED',p_correlation_id,jsonb_build_object('deletedCount',deleted));
  END IF;
  RETURN deleted;
END $$;
REVOKE ALL ON FUNCTION purge_expired_audit_events(text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_expired_audit_events(text,text,text,text,text) TO duefold_worker;
ALTER FUNCTION purge_expired_audit_events(text,text,text,text,text) OWNER TO duefold_migration;

-- Seeded once and due a day after migration; the runner queues each next run.
INSERT INTO job_queue(id,job_type,idempotency_key,payload,available_at,max_attempts)
VALUES(replace(gen_random_uuid()::text,'-',''),'audit.retention.sweep','audit-retention:initial',
       '{}'::jsonb,statement_timestamp()+interval '1 day',10);
