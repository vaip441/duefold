-- Duefold deployment status: observations recorded by the process that can make them, and
-- the Owner/Admin readers the status surface shows. Immutable after application.

/*
 * One row per check, overwritten in place. A check that has never run has no row.
 *
 * `code` is a code, not a summary: its pattern cannot hold an issuer URL, endpoint, bucket,
 * host, e-mail, key or path, so no observation can carry configuration (§20.3). Each
 * evidence column belongs to one check.
 */
CREATE TABLE deployment_status_observation (
  check_name text PRIMARY KEY
    CHECK (check_name IN ('storage-privacy','storage-versioning','scanner','updates')),
  result text NOT NULL CHECK (result IN ('pass','attention','fail')),
  code text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  evidence_at timestamptz CHECK (evidence_at IS NULL OR check_name='scanner'),
  evidence_version text CHECK (evidence_version IS NULL
    OR (check_name='updates' AND evidence_version ~ '^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$')),
  observed_at timestamptz NOT NULL
);
COMMENT ON TABLE deployment_status_observation IS
  'Latest answer of each status check that only the worker or an operator can make. Codes only; no configuration.';
REVOKE ALL ON deployment_status_observation
  FROM PUBLIC,duefold_runtime,duefold_authenticator,duefold_worker;

/*
 * Each check has exactly one writer, granted only to the process that runs it: the worker
 * observes storage and the scanner; the CLI, connecting as the migration role, records the
 * update check. The web credential writes nothing here.
 */
CREATE FUNCTION record_worker_status_observation(
  p_check text,p_result text,p_code text,p_evidence_at timestamptz
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF p_check IS NULL OR p_check NOT IN ('storage-privacy','storage-versioning','scanner') THEN
    RAISE EXCEPTION 'not a worker status check' USING ERRCODE='42501';
  END IF;
  /* Only the scanner has a signature build time to report, so a caller offering one for
     another check has confused its checks and is told which rule it broke. */
  IF p_evidence_at IS NOT NULL AND p_check<>'scanner' THEN
    RAISE EXCEPTION 'evidence timestamp belongs to the scanner check' USING ERRCODE='22023';
  END IF;
  INSERT INTO deployment_status_observation(check_name,result,code,evidence_at,observed_at)
  VALUES(p_check,p_result,p_code,p_evidence_at,statement_timestamp())
  ON CONFLICT (check_name) DO UPDATE
    SET result=EXCLUDED.result,code=EXCLUDED.code,evidence_at=EXCLUDED.evidence_at,
        observed_at=EXCLUDED.observed_at;
END $$;

CREATE FUNCTION record_update_observation(
  p_result text,p_code text,p_offered_version text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  INSERT INTO deployment_status_observation(check_name,result,code,evidence_version,observed_at)
  VALUES('updates',p_result,p_code,p_offered_version,statement_timestamp())
  ON CONFLICT (check_name) DO UPDATE
    SET result=EXCLUDED.result,code=EXCLUDED.code,evidence_version=EXCLUDED.evidence_version,
        observed_at=EXCLUDED.observed_at;
END $$;

/*
 * The facts the status surface reads from PostgreSQL.
 *
 * `jobs_due` counts pending work whose time has come; a self-rescheduling sweep waiting for
 * its next hour is not a backlog. Its age is computed here, on the database clock, so the
 * browser never does arithmetic on its own clock. Failures and mail evidence look back seven
 * days, so a fault that has been fixed stops being reported without anyone deleting history.
 * The mail job types are core-security's required mail.
 */
CREATE FUNCTION read_deployment_status(p_actor_id text)
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
    SELECT
      ARRAY(SELECT a.id FROM read_applied_migration_ids() a),
      (SELECT count(*)::integer FROM job_queue j
        WHERE j.state='pending' AND j.available_at<=statement_timestamp()),
      (SELECT count(*)::integer FROM job_queue j WHERE j.state='running'),
      (SELECT count(*)::integer FROM job_queue j
        WHERE j.state='failed' AND j.updated_at>window_start),
      (SELECT floor(extract(epoch FROM statement_timestamp()-min(j.available_at)))::integer
         FROM job_queue j WHERE j.state='pending' AND j.available_at<=statement_timestamp()),
      (SELECT max(j.updated_at) FROM job_queue j
        WHERE j.state='succeeded' AND j.job_type=ANY(mail_jobs)),
      (SELECT count(*)::integer FROM job_queue j
        WHERE j.state='failed' AND j.job_type=ANY(mail_jobs) AND j.updated_at>window_start);
END $$;

/*
 * Every check, in display order, whether or not it has run. Staleness follows each check's
 * writer: the worker observes hourly, so three missed runs is stale; the update check is as
 * fresh as the last time an operator ran it, and thirty days without one is stale.
 */
CREATE FUNCTION read_status_observations(p_actor_id text)
RETURNS TABLE(check_name text,result text,code text,evidence_at timestamptz,
              evidence_version text,observed_at timestamptz,stale boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM assert_organization_administrator(p_actor_id);
  RETURN QUERY
    SELECT c.name,o.result,o.code,o.evidence_at,o.evidence_version,o.observed_at,
           coalesce(o.observed_at<statement_timestamp()-c.stale_after,false)
      FROM (VALUES (1,'storage-privacy',interval '3 hours'),
                   (2,'storage-versioning',interval '3 hours'),
                   (3,'scanner',interval '3 hours'),
                   (4,'updates',interval '30 days')) AS c(ordinal,name,stale_after)
      LEFT JOIN deployment_status_observation o ON o.check_name=c.name
     ORDER BY c.ordinal;
END $$;

REVOKE ALL ON FUNCTION record_worker_status_observation(text,text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_update_observation(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION read_deployment_status(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION read_status_observations(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_worker_status_observation(text,text,text,timestamptz) TO duefold_worker;
GRANT EXECUTE ON FUNCTION read_deployment_status(text) TO duefold_runtime;
GRANT EXECUTE ON FUNCTION read_status_observations(text) TO duefold_runtime;
ALTER FUNCTION record_worker_status_observation(text,text,text,timestamptz) OWNER TO duefold_migration;
ALTER FUNCTION record_update_observation(text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION read_deployment_status(text) OWNER TO duefold_migration;
ALTER FUNCTION read_status_observations(text) OWNER TO duefold_migration;
