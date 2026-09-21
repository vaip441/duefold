-- Duefold content status: failed processing and the recovery record for the Owner/Admin
-- status surface. Immutable after application.

/*
 * Always one row. The failed-document count does not depend on the recovery record, so it
 * stays answerable even where that record is absent; the recovery columns are then null and
 * the surface says the backup status is undetermined.
 */
CREATE FUNCTION read_content_status(p_actor_id text)
RETURNS TABLE(failed_processing_count integer,backup_status text,backup_retention text,
              recovery_expectation text,acknowledged_at timestamptz,
              restore_drill_status text,restore_drill_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM assert_organization_administrator(p_actor_id);
  RETURN QUERY
    SELECT (SELECT count(*)::integer FROM document_version v WHERE v.state='processing_failed'),
           s.backup_status,s.backup_retention,s.recovery_expectation,s.acknowledged_at,
           s.restore_drill_status,s.restore_drill_at
      FROM (VALUES(true)) AS present(k)
      LEFT JOIN operational_recovery_status s ON s.singleton;
END $$;

REVOKE ALL ON FUNCTION read_content_status(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_content_status(text) TO duefold_runtime;
ALTER FUNCTION read_content_status(text) OWNER TO duefold_migration;

-- The status observation job, seeded once and due an hour after migration; each run queues
-- the next under its own lease.
INSERT INTO job_queue(id,job_type,idempotency_key,payload,available_at,max_attempts)
VALUES(replace(gen_random_uuid()::text,'-',''),'status.observe','status-observe:initial',
       '{}'::jsonb,statement_timestamp()+interval '1 hour',10);

