-- Viewer invitations: reissue, re-invite, and acceptance at first sign-in.
--
-- A lapsed pending invitation is expired before a new one is issued, and an outstanding
-- one is extended in place so mail already queued for it still delivers. A viewer whose
-- invitation was accepted receives a fresh pending row for the new room's mail; it is
-- never accepted, so it cannot collide with one_accepted_invitation.
CREATE OR REPLACE FUNCTION create_viewer_invitation(
  p_id text,p_viewer_id text,p_membership_id text,p_email_key text,p_email_display text,
  p_room_id text,p_actor_id text,p_expected_room_revision integer,p_job_id text,
  p_audit_id text,p_correlation_id text
) RETURNS TABLE(invitation_id text,viewer_id text,expires_at timestamptz,room_revision integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE next_revision integer; expiry timestamptz:=statement_timestamp()+interval '7 days';
  selected_viewer text; issued_id text; lapsed_id text;
BEGIN
  IF p_email_key IS NULL OR NOT canonical_email_key(p_email_key)
     OR p_email_display IS NULL OR length(p_email_display) NOT BETWEEN 3 AND 320
     OR normalize(lower(btrim(p_email_display)),NFC)<>p_email_key
     OR p_email_display<>normalize(btrim(p_email_display),NFC) THEN
    RAISE EXCEPTION 'invalid invitation email' USING ERRCODE='22023';
  END IF;
  UPDATE room SET revision=revision+1
    WHERE id=p_room_id AND revision=p_expected_room_revision
      AND member_can_mutate_room(p_actor_id,p_room_id,true)
    RETURNING revision INTO next_revision;
  IF next_revision IS NULL THEN
    RAISE EXCEPTION 'viewer invitation forbidden or stale' USING ERRCODE='42501';
  END IF;
  SELECT v.id INTO selected_viewer FROM viewer v WHERE v.email_key=p_email_key AND v.state='active';
  IF selected_viewer IS NULL THEN
    INSERT INTO viewer(id,email_key,email_display,state,session_family_id)
    VALUES(p_viewer_id,p_email_key,p_email_display,'active',replace(gen_random_uuid()::text,'-',''));
    selected_viewer:=p_viewer_id;
  END IF;
  INSERT INTO viewer_room_membership(id,viewer_id,room_id)
  VALUES(p_membership_id,selected_viewer,p_room_id)
  ON CONFLICT ON CONSTRAINT viewer_room_membership_viewer_id_room_id_key
  DO UPDATE SET state='active',revision=viewer_room_membership.revision+1;
  UPDATE invitation i SET state='expired'
    WHERE i.kind='viewer' AND i.email_key=p_email_key AND i.state='pending'
      AND i.expires_at<=statement_timestamp()
    RETURNING i.id INTO lapsed_id;
  IF lapsed_id IS NOT NULL THEN
    INSERT INTO audit_event(id,event_type,actor_kind,resource_type,resource_id,
      result,reason_code,correlation_id,detail)
    VALUES(replace(gen_random_uuid()::text,'-',''),'invitation.expired','system',
      'invitation',lapsed_id,'success','VIEWER_INVITATION_EXPIRED',p_correlation_id,
      jsonb_build_object('supersededBy',p_id,'noticedBy',p_actor_id,
        'occurredBefore',statement_timestamp()));
    DELETE FROM job_queue j
      WHERE j.job_type='mail.viewer_invitation' AND j.payload->>'invitationId'=lapsed_id
        AND j.state='pending';
  END IF;
  UPDATE invitation i SET expires_at=expiry
    WHERE i.kind='viewer' AND i.email_key=p_email_key AND i.state='pending'
    RETURNING i.id INTO issued_id;
  IF issued_id IS NULL THEN
    INSERT INTO invitation(id,kind,email_key,email_display,state,expires_at)
    VALUES(p_id,'viewer',p_email_key,p_email_display,'pending',expiry);
    issued_id:=p_id;
  END IF;
  INSERT INTO job_queue(id,job_type,idempotency_key,payload,available_at,max_attempts)
  VALUES(p_job_id,'mail.viewer_invitation','viewer-invitation:'||p_id,
    jsonb_build_object('invitationId',issued_id,'roomId',p_room_id),statement_timestamp(),5);
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,subject_id,room_id,resource_type,resource_id,
    result,reason_code,correlation_id,detail)
  VALUES(p_audit_id,'participant.viewer.invite','member',p_actor_id,selected_viewer,p_room_id,'invitation',issued_id,
    'success','VIEWER_INVITED',p_correlation_id,jsonb_build_object('expiresAt',expiry));
  RETURN QUERY SELECT issued_id,selected_viewer,expiry,next_revision;
END $$;

-- OTP issue eligibility: a viewer removed from every room gets no code. The authenticator
-- holds no privilege on viewer_room_membership, so it asks this single question.
CREATE FUNCTION viewer_holds_room_membership(p_viewer_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS(
    SELECT 1 FROM viewer_room_membership m WHERE m.viewer_id=p_viewer_id AND m.state='active')
$$;

-- Runs in the transaction that consumes the code. The challenge carries a viewer only
-- when an unexpired pending or an accepted invitation existed at issue, so the pending
-- row is accepted even if its seven days ran out during the code's ten-minute life.
CREATE FUNCTION accept_viewer_invitation(p_challenge_id text,p_audit_id text,p_correlation_id text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE accepted_id text; accepting_viewer text;
BEGIN
  UPDATE invitation i SET state='accepted'
    FROM otp_challenge o JOIN viewer v ON v.id=o.viewer_id AND v.state='active'
    WHERE o.id=p_challenge_id AND o.state='consumed'
      AND i.kind='viewer' AND i.email_key=v.email_key AND i.state='pending'
      AND NOT EXISTS(
        SELECT 1 FROM invitation a
        WHERE a.kind='viewer' AND a.email_key=v.email_key AND a.state='accepted')
    RETURNING i.id,v.id INTO accepted_id,accepting_viewer;
  IF accepted_id IS NULL THEN RETURN; END IF;
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,subject_id,resource_type,resource_id,
    result,reason_code,correlation_id)
  VALUES(p_audit_id,'invitation.accepted','viewer',accepting_viewer,accepting_viewer,
    'invitation',accepted_id,'success','VIEWER_INVITATION_ACCEPTED',p_correlation_id);
END $$;

-- A path-only ancestor's description is blanked in the projection, so matching must use
-- the projected text; matching the raw entry would confirm words of a hidden description.
CREATE OR REPLACE FUNCTION read_viewer_published_search(
  p_viewer_id text,p_session_id text,p_room_id text,p_query text,p_limit integer
) RETURNS TABLE(resource_kind text,resource_id text,display_name text,description text,path text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF length(p_query) NOT BETWEEN 1 AND 200 OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid search bounds' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  WITH RECURSIVE visible AS (
    SELECT p.*,p.display_name::text full_path
    FROM read_viewer_published_structure(p_viewer_id,p_session_id,p_room_id) p
    WHERE p.parent_folder_id IS NULL
    UNION ALL
    SELECT child.*,(parent.full_path||' / '||child.display_name)::text
    FROM visible parent JOIN read_viewer_published_structure(
      p_viewer_id,p_session_id,p_room_id) child
      ON child.parent_folder_id=parent.resource_id
  ), search_matched AS MATERIALIZED (
    SELECT p.entry_id,p.room_id
    FROM published_structure_entry p
    WHERE search_text_matches(p.display_name||' '||p.description,p_query)
  ), matched AS (
    SELECT p.entry_id
    FROM search_matched p
    WHERE p.room_id=p_room_id
  )
  SELECT v.resource_kind,v.resource_id,v.display_name,v.description,v.full_path
  FROM visible v JOIN matched m ON m.entry_id=v.entry_id
  WHERE search_text_matches(v.display_name||' '||v.description,p_query)
  ORDER BY v.full_path,v.order_key,v.entry_id LIMIT p_limit;
END $$;

-- Releases before 037 never accepted a viewer invitation, so an investor who already
-- signed in still holds a pending row that lapses after seven days. Accept it when the
-- active viewer signed in after it was issued; one_pending_invitation leaves at most one
-- such row per email, and an email that already has an accepted row is skipped.
WITH backfilled AS (
  UPDATE invitation i SET state='accepted'
  FROM viewer v
  WHERE i.kind='viewer' AND i.state='pending' AND v.email_key=i.email_key AND v.state='active'
    AND NOT EXISTS(
      SELECT 1 FROM invitation a
      WHERE a.kind='viewer' AND a.email_key=i.email_key AND a.state='accepted')
    AND (EXISTS(
      SELECT 1 FROM otp_challenge o
      WHERE o.viewer_id=v.id AND o.state='consumed' AND o.created_at>=i.created_at)
    OR EXISTS(
      SELECT 1 FROM session s
      WHERE s.principal_kind='viewer' AND s.viewer_id=v.id AND s.created_at>=i.created_at))
  RETURNING i.id AS invitation_id,v.id AS viewer_id
)
INSERT INTO audit_event(id,event_type,actor_kind,subject_id,resource_type,resource_id,
  result,reason_code,correlation_id,detail)
SELECT md5('viewer-invitation-backfill:'||b.invitation_id),'invitation.accepted','system',
  b.viewer_id,'invitation',b.invitation_id,'success','VIEWER_INVITATION_ACCEPTED',
  'corr_'||md5('viewer-invitation-backfill-correlation:'||b.invitation_id),
  jsonb_build_object('migration','037_investor_access_corrections')
FROM backfilled b;

REVOKE ALL ON FUNCTION accept_viewer_invitation(text,text,text)
  FROM PUBLIC,duefold_runtime,duefold_worker,duefold_authenticator;
GRANT EXECUTE ON FUNCTION accept_viewer_invitation(text,text,text) TO duefold_authenticator;
ALTER FUNCTION accept_viewer_invitation(text,text,text) OWNER TO duefold_migration;
REVOKE ALL ON FUNCTION viewer_holds_room_membership(text)
  FROM PUBLIC,duefold_runtime,duefold_worker,duefold_authenticator;
GRANT EXECUTE ON FUNCTION viewer_holds_room_membership(text) TO duefold_authenticator;
ALTER FUNCTION viewer_holds_room_membership(text) OWNER TO duefold_migration;
