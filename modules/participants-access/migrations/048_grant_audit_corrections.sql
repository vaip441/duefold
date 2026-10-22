-- The grant change audit subject is the grantee stored on the grant row.
--
-- Revoke and expiry requests also carry viewer and counterparty fields that nothing
-- checks against the selected grant, so recording those named whoever the caller chose,
-- or no one. The row each branch writes is the only authoritative grantee.
CREATE OR REPLACE FUNCTION apply_grant_change(
  p_actor_id text,p_room_id text,p_action text,p_grant_id text,p_grantee_kind text,
  p_viewer_id text,p_counterparty_id text,p_target_kind text,p_folder_id text,
  p_document_id text,p_expires_at timestamptz,p_expected_room_revision integer,
  p_oidc_authenticated_at timestamptz,p_confirmation text,p_audit_id text,p_correlation_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE impact jsonb; resolved_expiry timestamptz; changed integer; broad_change boolean;
  audit_subject text;
BEGIN
  impact:=dry_run_grant_change(p_actor_id,p_room_id,p_action,p_grant_id,p_grantee_kind,
    p_viewer_id,p_counterparty_id,p_target_kind,p_folder_id,p_document_id,p_expires_at);
  IF p_confirmation IS DISTINCT FROM impact->>'confirmation' THEN
    RAISE EXCEPTION 'typed confirmation mismatch' USING ERRCODE='22023';
  END IF;
  IF p_action='grant' THEN
    broad_change:=p_target_kind='room' OR p_grantee_kind='counterparty';
  ELSE
    SELECT (g.target_kind='room' OR g.grantee_kind='counterparty') INTO broad_change
    FROM access_grant g WHERE g.id=p_grant_id AND g.room_id=p_room_id AND g.state='active';
  END IF;
  IF COALESCE(broad_change,false) AND
     (p_oidc_authenticated_at IS NULL OR p_oidc_authenticated_at>statement_timestamp()
       OR p_oidc_authenticated_at<=statement_timestamp()-interval '15 minutes') THEN
    RAISE EXCEPTION 'fresh OIDC required' USING ERRCODE='42501';
  END IF;
  UPDATE room SET revision=revision+1 WHERE id=p_room_id AND revision=p_expected_room_revision
    AND member_can_mutate_room(p_actor_id,p_room_id,true);
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>1 THEN RAISE EXCEPTION 'stale room revision' USING ERRCODE='40001'; END IF;
  resolved_expiry:=NULLIF(impact->>'resolvedExpiresAt','')::timestamptz;
  IF p_action='grant' THEN
    INSERT INTO access_grant(id,room_id,grantee_kind,viewer_id,counterparty_id,target_kind,
      folder_id,document_id,expires_at,created_by)
    VALUES(p_grant_id,p_room_id,p_grantee_kind,p_viewer_id,p_counterparty_id,p_target_kind,
      p_folder_id,p_document_id,resolved_expiry,p_actor_id)
    RETURNING COALESCE(viewer_id,counterparty_id) INTO audit_subject;
  ELSIF p_action='revoke' THEN
    UPDATE access_grant SET state='revoked',revoked_at=transaction_timestamp(),revision=revision+1
      WHERE id=p_grant_id AND room_id=p_room_id AND state='active'
      RETURNING COALESCE(viewer_id,counterparty_id) INTO audit_subject;
    IF NOT FOUND THEN RAISE EXCEPTION 'stale grant' USING ERRCODE='40001'; END IF;
  ELSE
    UPDATE access_grant SET expires_at=resolved_expiry,revision=revision+1
      WHERE id=p_grant_id AND room_id=p_room_id AND state='active'
      RETURNING COALESCE(viewer_id,counterparty_id) INTO audit_subject;
    IF NOT FOUND THEN RAISE EXCEPTION 'stale grant' USING ERRCODE='40001'; END IF;
  END IF;
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,subject_id,room_id,resource_type,
    resource_id,result,reason_code,correlation_id,detail)
  VALUES(p_audit_id,'grant.'||p_action,'member',p_actor_id,audit_subject,
    p_room_id,'grant',p_grant_id,'success',upper(p_action)||'_APPLIED',p_correlation_id,
    jsonb_build_object('action',p_action,'affectedCount',impact->'affectedCount','paths',impact->'paths',
      'expiresAt',impact->'resolvedExpiresAt'));
  RETURN impact||jsonb_build_object('roomRevision',p_expected_room_revision+1);
END $$;

-- Neither authorizer has had a caller since 040 revoked runtime EXECUTE: viewer
-- discovery and delivery authorize through the session-digest-bound functions.
DROP FUNCTION authorize_viewer_published_room(text,text,text);
DROP FUNCTION read_viewer_document_download_policy(text,text,text,text);
