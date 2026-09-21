-- Duefold installation settings: the installation-wide original-download default as a
-- reviewed change. Immutable after application.

CREATE FUNCTION installation_download_allow_confirmation() RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT 'ALLOW ORIGINAL DOWNLOADS'::text
$$;

CREATE FUNCTION read_installation_settings(p_actor_id text)
RETURNS TABLE(download_policy text,policy_revision integer,inheriting_room_count integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM assert_organization_administrator(p_actor_id);
  RETURN QUERY
    SELECT o.installation_download_policy,o.policy_revision,
           (SELECT count(*)::integer FROM room r WHERE r.download_policy IS NULL)
      FROM organization o;
END $$;

/*
 * What changing the default reaches: every room without its own policy, and of what viewers
 * can open today, every published document in a published room where neither the room nor
 * the document sets its own policy. Allowing is the broad direction, so it carries the
 * phrase and needs a fresh sign-in; denying only removes access and needs neither.
 */
CREATE FUNCTION dry_run_installation_download_policy(p_actor_id text,p_policy text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE current_policy text; current_revision integer;
BEGIN
  PERFORM assert_organization_administrator(p_actor_id);
  IF p_policy IS NULL OR p_policy NOT IN ('allow','deny') THEN
    RAISE EXCEPTION 'invalid download policy' USING ERRCODE='22023';
  END IF;
  SELECT o.installation_download_policy,o.policy_revision INTO current_policy,current_revision
    FROM organization o;
  IF current_policy=p_policy THEN
    RAISE EXCEPTION 'installation already has that download policy' USING ERRCODE='55000';
  END IF;
  RETURN jsonb_build_object(
    'currentPolicy',current_policy,
    'proposedPolicy',p_policy,
    'inheritingRoomCount',(SELECT count(*)::integer FROM room r WHERE r.download_policy IS NULL),
    'affectedDocumentCount',(SELECT count(*)::integer
       FROM published_structure_entry e
       JOIN room r ON r.id=e.room_id
       JOIN document d ON d.id=e.resource_id
      WHERE e.resource_kind='document' AND r.state='published'
        AND r.download_policy IS NULL AND d.download_policy IS NULL),
    'requiresFreshAuthentication',p_policy='allow',
    'expectedRevision',current_revision,
    'confirmation',CASE WHEN p_policy='allow' THEN installation_download_allow_confirmation() END);
END $$;

CREATE FUNCTION apply_installation_download_policy(
  p_actor_id text,p_policy text,p_expected_revision integer,
  p_oidc_authenticated_at timestamptz,p_confirmation text,p_audit_id text,p_correlation_id text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE current_policy text; current_revision integer; next_revision integer;
BEGIN
  PERFORM assert_organization_administrator(p_actor_id);
  IF p_policy IS NULL OR p_policy NOT IN ('allow','deny')
     OR (p_policy='deny') <> (p_confirmation IS NULL) THEN
    RAISE EXCEPTION 'invalid installation download change' USING ERRCODE='22023';
  END IF;
  SELECT o.installation_download_policy,o.policy_revision INTO current_policy,current_revision
    FROM organization o FOR UPDATE;
  IF current_revision<>p_expected_revision THEN
    RAISE EXCEPTION 'stale installation policy' USING ERRCODE='40001';
  END IF;
  IF current_policy=p_policy THEN
    RAISE EXCEPTION 'installation already has that download policy' USING ERRCODE='55000';
  END IF;
  IF p_policy='allow' AND (p_oidc_authenticated_at IS NULL
       OR p_oidc_authenticated_at>statement_timestamp()
       OR p_oidc_authenticated_at<=statement_timestamp()-interval '15 minutes') THEN
    RAISE EXCEPTION 'fresh OIDC required' USING ERRCODE='42501';
  END IF;
  IF p_policy='allow' AND p_confirmation IS DISTINCT FROM installation_download_allow_confirmation() THEN
    RAISE EXCEPTION 'typed confirmation mismatch' USING ERRCODE='22023';
  END IF;
  UPDATE organization SET installation_download_policy=p_policy,policy_revision=policy_revision+1
  RETURNING policy_revision INTO next_revision;
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,resource_type,result,reason_code,
                          correlation_id,detail)
  VALUES(p_audit_id,'download.policy','member',p_actor_id,'organization','success',
         'INSTALLATION_DOWNLOAD_POLICY_CHANGED',p_correlation_id,
         jsonb_build_object('policy',p_policy,'policyRevision',next_revision));
  RETURN next_revision;
END $$;

-- The 007 setter changes the default with none of the review's rules; the web credential
-- reaches the default only through the functions above.
REVOKE EXECUTE ON FUNCTION set_installation_download_policy(text,text,integer,text,text)
  FROM duefold_runtime;

REVOKE ALL ON FUNCTION installation_download_allow_confirmation() FROM PUBLIC;
REVOKE ALL ON FUNCTION read_installation_settings(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION dry_run_installation_download_policy(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION apply_installation_download_policy(text,text,integer,timestamptz,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_installation_settings(text) TO duefold_runtime;
GRANT EXECUTE ON FUNCTION dry_run_installation_download_policy(text,text) TO duefold_runtime;
GRANT EXECUTE ON FUNCTION apply_installation_download_policy(text,text,integer,timestamptz,text,text,text) TO duefold_runtime;
ALTER FUNCTION installation_download_allow_confirmation() OWNER TO duefold_migration;
ALTER FUNCTION read_installation_settings(text) OWNER TO duefold_migration;
ALTER FUNCTION dry_run_installation_download_policy(text,text) OWNER TO duefold_migration;
ALTER FUNCTION apply_installation_download_policy(text,text,integer,timestamptz,text,text,text) OWNER TO duefold_migration;
