-- Duefold organization administration. This migration is immutable after application.
--
-- The operating organization's own people: invitations that carry the role granted at
-- acceptance, role and state administration, room assignments, and ownership transfer.
--
-- Every mutation here is a SECURITY DEFINER function that authorizes the actor itself
-- and writes its audit row in the SAME transaction (invariant 14, §15.1). The
-- application roles keep SELECT at most on the tables involved, so there is no path
-- from the web or worker process to a role, a state, a room privilege, or an
-- invitation's intended role except through these functions. A check in TypeScript
-- would be advisory and could drift from the authoritative one.
--
-- Read the three cross-cutting rules once here rather than at each function:
--
-- 1. REFUSALS ARE SQLSTATEs. 42501 forbidden, 22023 invalid argument, 23505 duplicate,
--    40001 stale revision. `failure-mapping.ts` turns each into its designed status and
--    forwards NONE of the database's wording, so a refusal cannot be used to discover
--    whether a member, address, or room exists. Only the 'fresh OIDC required' marker
--    survives, because a re-authentication prompt is a different instruction from a
--    denial and the client must not guess which it received.
-- 2. A NO-OP IS REFUSED, NOT SILENTLY ACCEPTED. An audit row is evidence that something
--    changed, so a request that changes nothing raises 22023 rather than writing one.
-- 3. SESSIONS ARE REVOKED BY 001'S TRIGGERS, NOT HERE.
--    `member_privilege_session_revoke` already revokes every active session of a member
--    whose global_role or state changed, and `room_assignment_privilege_session_revoke`
--    fires on every room_assignment row change. A second revocation written here would
--    be a parallel rule free to drift from the kernel's.

ALTER TABLE invitation
  ADD COLUMN intended_global_role text,
  ADD COLUMN invited_by text REFERENCES member(id);

UPDATE invitation
SET intended_global_role = 'member'
WHERE kind = 'member';

ALTER TABLE invitation
  ADD CONSTRAINT invitation_intended_global_role_valid CHECK (
    intended_global_role IS NULL OR intended_global_role IN ('admin', 'member')
  ),
  ADD CONSTRAINT invitation_role_matches_kind CHECK (
    (kind = 'member' AND intended_global_role IS NOT NULL) OR
    (kind = 'viewer' AND intended_global_role IS NULL)
  );

ALTER TABLE invitation DROP CONSTRAINT invitation_kind_email_key_state_key;
CREATE UNIQUE INDEX one_pending_invitation
  ON invitation (kind, email_key)
  WHERE state = 'pending';
CREATE UNIQUE INDEX one_accepted_invitation
  ON invitation (kind, email_key)
  WHERE state = 'accepted';

ALTER TABLE room_assignment DROP CONSTRAINT room_assignment_room_id_member_id_key;
CREATE UNIQUE INDEX one_active_room_assignment
  ON room_assignment (room_id, member_id)
  WHERE state = 'active';
CREATE INDEX active_room_assignment_member
  ON room_assignment (member_id)
  WHERE state = 'active';

-- The Owner/Admin gate every mutation below calls first.
CREATE FUNCTION assert_organization_administrator(p_actor_id text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM member
    WHERE id = p_actor_id
      AND state = 'active'
      AND global_role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'organization administration forbidden' USING ERRCODE = '42501';
  END IF;
END $$;

-- Withdrawing a pending invitation must also stop its mail, or a revoked invitation
-- still delivers a working link.
CREATE FUNCTION cancel_member_invitation_mail(p_invitation_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  DELETE FROM job_queue
  WHERE job_type = 'mail.member_invitation'
    AND payload->>'invitationId' = p_invitation_id
    AND state = 'pending';
END $$;

-- Inviting an internal member.
--
-- The invitation carries the role granted at acceptance, so the decision is audited when
-- it is MADE rather than inferred at first sign-in. Set-based: every validation runs
-- before any write.
CREATE FUNCTION invite_member(
  p_id text,
  p_email_key text,
  p_email_display text,
  p_intended_role text,
  p_actor_id text,
  p_job_id text,
  p_audit_id text,
  p_correlation_id text
) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  expiry timestamptz := statement_timestamp() + interval '7 days';
  lapsed_id text;
BEGIN
  PERFORM assert_organization_administrator(p_actor_id);
  IF p_intended_role IS NULL OR p_intended_role NOT IN ('admin', 'member') THEN
    RAISE EXCEPTION 'invalid intended role' USING ERRCODE = '22023';
  END IF;
  IF p_email_key IS NULL OR NOT canonical_email_key(p_email_key)
     OR p_email_display IS NULL OR length(p_email_display) NOT BETWEEN 3 AND 320
     OR normalize(lower(btrim(p_email_display)), NFC) <> p_email_key
     OR p_email_display <> normalize(btrim(p_email_display), NFC) THEN
    RAISE EXCEPTION 'invalid invitation email' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM member WHERE email_key = p_email_key) THEN
    RAISE EXCEPTION 'member already exists' USING ERRCODE = '23505';
  END IF;
  UPDATE invitation
  SET state = 'expired'
  WHERE kind = 'member'
    AND email_key = p_email_key
    AND state = 'pending'
    AND expires_at <= statement_timestamp()
  RETURNING id INTO lapsed_id;
  IF lapsed_id IS NOT NULL THEN
    INSERT INTO audit_event (
      id, event_type, actor_kind, resource_type, resource_id,
      result, reason_code, correlation_id, detail
    ) VALUES (
      replace(gen_random_uuid()::text, '-', ''), 'invitation.expired', 'system',
      'invitation', lapsed_id, 'success', 'MEMBER_INVITATION_EXPIRED', p_correlation_id,
      jsonb_build_object(
        'supersededBy', p_id,
        'noticedBy', p_actor_id,
        'occurredBefore', statement_timestamp()
      )
    );
    PERFORM cancel_member_invitation_mail(lapsed_id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM invitation
    WHERE kind = 'member' AND email_key = p_email_key AND state = 'pending'
  ) THEN
    RAISE EXCEPTION 'member invitation already pending' USING ERRCODE = '23505';
  END IF;
  INSERT INTO invitation (
    id, kind, email_key, email_display, state, expires_at,
    intended_global_role, invited_by
  ) VALUES (
    p_id, 'member', p_email_key, p_email_display, 'pending', expiry,
    p_intended_role, p_actor_id
  );
  INSERT INTO job_queue (
    id, job_type, idempotency_key, payload, available_at, max_attempts
  ) VALUES (
    p_job_id, 'mail.member_invitation', 'member-invitation:' || p_id,
    jsonb_build_object('invitationId', p_id), statement_timestamp(), 5
  );
  INSERT INTO audit_event (
    id, event_type, actor_kind, actor_id, resource_type, resource_id,
    result, reason_code, correlation_id, detail
  ) VALUES (
    p_audit_id, 'invitation.created', 'member', p_actor_id, 'invitation', p_id,
    'success', 'MEMBER_INVITED', p_correlation_id,
    jsonb_build_object('intendedRole', p_intended_role, 'expiresAt', expiry)
  );
  RETURN expiry;
END $$;


CREATE FUNCTION revoke_member_invitation(
  p_invitation_id text,
  p_actor_id text,
  p_audit_id text,
  p_correlation_id text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM assert_organization_administrator(p_actor_id);
  UPDATE invitation
  SET state = 'revoked'
  WHERE id = p_invitation_id
    AND kind = 'member'
    AND state = 'pending';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invitation not pending' USING ERRCODE = '40001';
  END IF;
  PERFORM cancel_member_invitation_mail(p_invitation_id);
  INSERT INTO audit_event (
    id, event_type, actor_kind, actor_id, resource_type, resource_id,
    result, reason_code, correlation_id
  ) VALUES (
    p_audit_id, 'invitation.revoked', 'member', p_actor_id, 'invitation', p_invitation_id,
    'success', 'MEMBER_INVITATION_REVOKED', p_correlation_id
  );
END $$;

-- Provisioning: the two paths that create a member row.
--
-- Both live in SQL because `duefold_authenticator` holds SELECT alone on `member` (see
-- the grants at the end of this file). An authenticator credential able to INSERT a
-- member could write global_role='admin' directly and bypass the invitation's audited
-- intended role entirely -- an escalation available to the one credential an
-- unauthenticated OIDC callback uses.
CREATE FUNCTION accept_member_invitation(
  p_member_id text,
  p_email_key text,
  p_email_display text,
  p_oidc_issuer text,
  p_oidc_subject text,
  p_correlation_id text,
  p_accept_audit_id text,
  p_member_audit_id text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  invitation_id text;
  intended_role text;
BEGIN
  IF NOT canonical_email_key(p_email_key) THEN
    RAISE EXCEPTION 'invalid acceptance email' USING ERRCODE = '22023';
  END IF;
  SELECT id, intended_global_role INTO invitation_id, intended_role
  FROM invitation
  WHERE kind = 'member' AND email_key = p_email_key AND state = 'pending'
    AND expires_at > transaction_timestamp()
  FOR UPDATE;
  IF invitation_id IS NULL THEN RETURN NULL; END IF;
  IF intended_role NOT IN ('admin', 'member') THEN
    RAISE EXCEPTION 'invitation names an unassignable role' USING ERRCODE = '22023';
  END IF;
  INSERT INTO member (
    id, email_key, email_display, oidc_issuer, oidc_subject, global_role, state
  ) VALUES (
    p_member_id, p_email_key, p_email_display, p_oidc_issuer, p_oidc_subject,
    intended_role, 'active'
  );
  UPDATE invitation SET state = 'accepted' WHERE id = invitation_id;
  INSERT INTO audit_event (
    id, event_type, actor_kind, actor_id, subject_id, resource_type, resource_id,
    result, reason_code, correlation_id, detail
  ) VALUES (
    p_accept_audit_id, 'invitation.accepted', 'member', p_member_id, p_member_id,
    'invitation', invitation_id, 'success', 'MEMBER_INVITATION_ACCEPTED',
    p_correlation_id, jsonb_build_object('intendedRole', intended_role)
  );
  INSERT INTO audit_event (
    id, event_type, actor_kind, actor_id, subject_id, resource_type, resource_id,
    result, reason_code, correlation_id, detail
  ) VALUES (
    p_member_audit_id, 'member.created', 'member', p_member_id, p_member_id,
    'member', p_member_id, 'success', 'MEMBER_INVITATION_ACCEPTED', p_correlation_id,
    jsonb_build_object('invitationId', invitation_id, 'globalRole', intended_role)
  );
  RETURN p_member_id;
END $$;


CREATE FUNCTION claim_first_owner(
  p_organization_id text,
  p_organization_name text,
  p_member_id text,
  p_email_key text,
  p_email_display text,
  p_oidc_issuer text,
  p_oidc_subject text,
  p_correlation_id text,
  p_audit_id text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT canonical_email_key(p_email_key) THEN
    RAISE EXCEPTION 'invalid bootstrap email' USING ERRCODE = '22023';
  END IF;
  LOCK TABLE organization, member IN EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM member WHERE global_role = 'owner' AND state = 'active') THEN
    RAISE EXCEPTION 'owner already exists' USING ERRCODE = '23505';
  END IF;
  INSERT INTO organization (id, name) VALUES (p_organization_id, p_organization_name);
  INSERT INTO member (
    id, email_key, email_display, oidc_issuer, oidc_subject, global_role, state
  ) VALUES (
    p_member_id, p_email_key, p_email_display, p_oidc_issuer, p_oidc_subject,
    'owner', 'active'
  );
  INSERT INTO audit_event (
    id, event_type, actor_kind, actor_id, subject_id, result, reason_code, correlation_id
  ) VALUES (
    p_audit_id, 'auth.oidc', 'member', p_member_id, p_member_id, 'success',
    'FIRST_OWNER_BOOTSTRAP', p_correlation_id
  );
END $$;

-- What THIS actor may do to ONE subject, decided in SQL.
--
-- The surface renders controls from this rather than inferring them from the subject's
-- role, because the rule is not "is a plain Member": each mutation also refuses
-- self-administration, the Owner, and a disabled target, and only PostgreSQL holds all
-- of those conditions at once. A surface that inferred them offered controls the server
-- then refused with a uniform 403 that could explain nothing.
--
-- This is NOT the authorization. Every mutation authorizes itself again; these flags only
-- keep the surface from offering an action that cannot succeed.
CREATE FUNCTION member_subject_capabilities(p_actor_id text, p_subject_id text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT jsonb_build_object(
    'setRole', actor.is_administrator
      AND NOT actor.is_self AND subject.exists AND NOT subject.is_owner,
    'setState', actor.is_administrator
      AND NOT actor.is_self AND subject.exists AND NOT subject.is_owner,
    'assignRooms', actor.is_administrator
      AND NOT actor.is_self AND subject.is_assignable_member,
    'transfer', actor.is_owner
      AND NOT actor.is_self AND subject.exists AND NOT subject.is_owner
      AND subject.is_active
  )
  FROM (
    SELECT
      EXISTS (
        SELECT 1 FROM member
        WHERE id = p_actor_id AND state = 'active' AND global_role IN ('owner', 'admin')
      ) AS is_administrator,
      EXISTS (
        SELECT 1 FROM member
        WHERE id = p_actor_id AND state = 'active' AND global_role = 'owner'
      ) AS is_owner,
      p_actor_id = p_subject_id AS is_self
  ) actor,
  (
    SELECT
      count(*) > 0 AS exists,
      coalesce(bool_or(m.global_role = 'owner'), false) AS is_owner,
      coalesce(bool_or(m.state = 'active'), false) AS is_active,
      coalesce(
        bool_or(m.global_role = 'member' AND m.state = 'active'), false
      ) AS is_assignable_member
    FROM member m WHERE m.id = p_subject_id
  ) subject
$$;

-- Whether this actor may administer members at all, for the frame deciding whether to
-- offer the Members view. Offering the tab to everyone and rendering a denied state gave
-- a plain Member a destination that could only ever refuse them.
CREATE FUNCTION may_administer_organization(p_actor_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM member
    WHERE id = p_actor_id AND state = 'active' AND global_role IN ('owner', 'admin')
  )
$$;

-- The member list: one bounded keyset page of members and pending invitations.
--
-- Members, invitations and assignments all grow, so §23 requires a bounded reader rather
-- than a full projection, and the bound is enforced HERE because the route is not the
-- authority.
--
-- EVERY SUBJECT CARRIES ITS COMPLETE ASSIGNMENT SET. The page is bounded by returning
-- fewer SUBJECTS, never by shortening one subject's rooms: a short room list reads as
-- that member's whole access, which would be a false statement about who can reach what.
-- A page can therefore be shorter than the limit and still continue, so `continues` is
-- the only completeness signal.
CREATE FUNCTION read_members(
  p_actor_id text,
  p_after_created_at timestamptz,
  p_after_subject_id text,
  p_limit integer
)
RETURNS TABLE(
  subject_kind text,
  subject_id text,
  email_display text,
  global_role text,
  state text,
  revision integer,
  created_at timestamptz,
  cursor_created_at text,
  assignments jsonb,
  capabilities jsonb,
  continues boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  budget constant integer := 500;
BEGIN
  PERFORM assert_organization_administrator(p_actor_id);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid member page size' USING ERRCODE = '22023';
  END IF;
  IF (p_after_created_at IS NULL) <> (p_after_subject_id IS NULL) THEN
    RAISE EXCEPTION 'incomplete member cursor' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    WITH subjects AS (
      SELECT
        'member'::text AS subject_kind,
        m.id AS subject_id,
        m.email_display,
        m.global_role,
        m.state,
        m.revision,
        m.created_at
      FROM member m
      UNION ALL
      SELECT
        'invitation'::text,
        i.id,
        i.email_display,
        i.intended_global_role,
        i.state,
        1,
        i.created_at
      FROM invitation i
      WHERE i.kind = 'member'
        AND i.state = 'pending'
        AND i.expires_at > statement_timestamp()
    ),
    candidates AS (
      SELECT s.*,
        row_number() OVER (ORDER BY s.created_at DESC, s.subject_id DESC) AS ordinal
      FROM subjects s
      WHERE p_after_created_at IS NULL
         OR (s.created_at, s.subject_id) < (p_after_created_at, p_after_subject_id)
      ORDER BY s.created_at DESC, s.subject_id DESC
      LIMIT p_limit + 1
    ),
    probe AS (
      SELECT c.ordinal
      FROM candidates c
      JOIN room_assignment a
        ON a.member_id = c.subject_id AND a.state = 'active'
      WHERE c.subject_kind = 'member' AND c.ordinal <= p_limit
      ORDER BY c.ordinal, a.room_id
      LIMIT budget + 1
    ),
    cut AS (
      SELECT greatest(max(p.ordinal), 2) AS first_excluded
      FROM probe p
      HAVING count(*) > budget
    ),
    admitted AS (
      SELECT c.*
      FROM candidates c
      WHERE c.ordinal <= p_limit
        AND c.ordinal < coalesce((SELECT cut.first_excluded FROM cut), p_limit + 1)
    )
    SELECT a.subject_kind, a.subject_id, a.email_display, a.global_role, a.state,
           a.revision, a.created_at, a.created_at::text,
           CASE WHEN a.subject_kind <> 'member' THEN '[]'::jsonb ELSE (
             SELECT coalesce(
               jsonb_agg(
                 jsonb_build_object('roomId', held.room_id, 'roomRole', held.room_role)
                 ORDER BY held.room_id
               ),
               '[]'::jsonb
             )
             FROM room_assignment held
             WHERE held.member_id = a.subject_id AND held.state = 'active'
           ) END,
           CASE WHEN a.subject_kind <> 'member'
             THEN jsonb_build_object(
               'setRole', false, 'setState', false,
               'assignRooms', false, 'transfer', false
             )
             ELSE member_subject_capabilities(p_actor_id, a.subject_id)
           END,
           EXISTS (
             SELECT 1 FROM candidates rest
             WHERE rest.ordinal > (SELECT max(kept.ordinal) FROM admitted kept)
           )
    FROM admitted a
    ORDER BY a.ordinal;
END $$;


CREATE FUNCTION read_member_invitation_mail(
  p_invitation_id text,
  p_job_id text,
  p_owner text,
  p_token text
) RETURNS TABLE(email_display text, occurred_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT
    CASE WHEN i.state = 'pending' AND i.expires_at > statement_timestamp()
         THEN i.email_display END,
    i.created_at
  FROM invitation i
  JOIN job_queue j ON j.id = p_job_id
  WHERE i.id = p_invitation_id
    AND i.kind = 'member'
    AND j.job_type = 'mail.member_invitation'
    AND j.payload->>'invitationId' = i.id
    AND j.state = 'running'
    AND j.lease_owner = p_owner
    AND j.lease_token = p_token
    AND j.lease_expires_at > statement_timestamp()
$$;

-- Promotion out of 'member' supersedes explicit assignments, which an Admin or Owner no
-- longer needs. Demotion does NOT restore them: that would grant room access as a side
-- effect of a request naming no room (invariant 7, allow-only grants). The audit row
-- names every revoked room, so the set is recoverable as an intentional batch.
CREATE FUNCTION supersede_room_assignments_for_role(
  p_member_id text,
  p_actor_id text,
  p_new_role text,
  p_correlation_id text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE superseded jsonb;
BEGIN
  WITH revoked AS (
    UPDATE room_assignment SET state = 'revoked'
    WHERE member_id = p_member_id AND state = 'active'
    RETURNING room_id, room_role
  )
  SELECT jsonb_agg(
    jsonb_build_object('roomId', r.room_id, 'roomRole', r.room_role) ORDER BY r.room_id
  ) INTO superseded
  FROM revoked r;
  IF superseded IS NULL THEN RETURN; END IF;
  INSERT INTO audit_event (
    id, event_type, actor_kind, actor_id, subject_id, resource_type, resource_id,
    result, reason_code, correlation_id, detail
  ) VALUES (
    replace(gen_random_uuid()::text, '-', ''), 'room.assignment', 'member', p_actor_id,
    p_member_id, 'member', p_member_id, 'success', 'ROOM_ASSIGNMENTS_SUPERSEDED',
    p_correlation_id,
    jsonb_build_object('revoked', superseded, 'reason', 'global_role', 'toRole', p_new_role)
  );
END $$;


CREATE FUNCTION set_member_global_role(
  p_target_id text,
  p_role text,
  p_actor_id text,
  p_expected_revision integer,
  p_audit_id text,
  p_correlation_id text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  previous_role text;
  target_revision integer;
  next_revision integer;
BEGIN
  PERFORM assert_organization_administrator(p_actor_id);
  IF p_role IS NULL OR p_role NOT IN ('admin', 'member') THEN
    RAISE EXCEPTION 'invalid global role' USING ERRCODE = '22023';
  END IF;
  IF p_target_id = p_actor_id THEN
    RAISE EXCEPTION 'self role administration forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT global_role, revision INTO previous_role, target_revision
  FROM member WHERE id = p_target_id FOR UPDATE;
  IF previous_role IS NULL OR previous_role = 'owner' THEN
    RAISE EXCEPTION 'target is not role-assignable' USING ERRCODE = '42501';
  END IF;
  IF target_revision <> p_expected_revision THEN
    RAISE EXCEPTION 'stale member revision' USING ERRCODE = '40001';
  END IF;
  IF previous_role = p_role THEN
    RAISE EXCEPTION 'member already holds that role' USING ERRCODE = '22023';
  END IF;
  UPDATE member SET global_role = p_role, revision = revision + 1
  WHERE id = p_target_id
  RETURNING revision INTO next_revision;
  IF p_role <> 'member' THEN
    PERFORM supersede_room_assignments_for_role(
      p_target_id, p_actor_id, p_role, p_correlation_id
    );
  END IF;
  INSERT INTO audit_event (
    id, event_type, actor_kind, actor_id, subject_id, resource_type, resource_id,
    result, reason_code, correlation_id, detail
  ) VALUES (
    p_audit_id, 'member.role', 'member', p_actor_id, p_target_id, 'member', p_target_id,
    'success', 'MEMBER_ROLE_CHANGED', p_correlation_id,
    jsonb_build_object('from', previous_role, 'to', p_role, 'revision', next_revision)
  );
  RETURN next_revision;
END $$;


CREATE FUNCTION set_member_state(
  p_target_id text,
  p_state text,
  p_actor_id text,
  p_expected_revision integer,
  p_audit_id text,
  p_correlation_id text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  target_role text;
  previous_state text;
  target_revision integer;
  next_revision integer;
BEGIN
  PERFORM assert_organization_administrator(p_actor_id);
  IF p_state IS NULL OR p_state NOT IN ('active', 'disabled') THEN
    RAISE EXCEPTION 'invalid member state' USING ERRCODE = '22023';
  END IF;
  IF p_target_id = p_actor_id THEN
    RAISE EXCEPTION 'self state administration forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT global_role, state, revision INTO target_role, previous_state, target_revision
  FROM member WHERE id = p_target_id FOR UPDATE;
  IF target_role IS NULL THEN
    RAISE EXCEPTION 'member not found' USING ERRCODE = '42501';
  END IF;
  IF target_role = 'owner' THEN
    RAISE EXCEPTION 'the Owner cannot be disabled; transfer ownership first'
      USING ERRCODE = '42501';
  END IF;
  IF target_revision <> p_expected_revision THEN
    RAISE EXCEPTION 'stale member revision' USING ERRCODE = '40001';
  END IF;
  IF previous_state = p_state THEN
    RAISE EXCEPTION 'member already in that state' USING ERRCODE = '22023';
  END IF;
  UPDATE member SET state = p_state, revision = revision + 1
  WHERE id = p_target_id
  RETURNING revision INTO next_revision;
  INSERT INTO audit_event (
    id, event_type, actor_kind, actor_id, subject_id, resource_type, resource_id,
    result, reason_code, correlation_id, detail
  ) VALUES (
    p_audit_id, 'member.state', 'member', p_actor_id, p_target_id, 'member', p_target_id,
    'success', 'MEMBER_STATE_CHANGED', p_correlation_id,
    jsonb_build_object('from', previous_state, 'to', p_state, 'revision', next_revision)
  );
  RETURN next_revision;
END $$;

-- Ownership transfer: a two-step, typed, audited change of the single Owner.
--
-- The preview row is EVIDENCE, not a copy of what was shown. It holds no personal data:
-- the rendered impact -- the successor's email display and the title of every room whose
-- assignment would be revoked -- is returned to the caller and never stored. Keeping it
-- here would have retained a named person's address and their room access indefinitely,
-- for every preview an Owner ever opened, including the ones they abandoned.
--
-- `target_assignment_digest` is what makes the approval binding without retaining the
-- list. `member.revision` does not move when a `room_assignment` row changes, so the
-- revision alone cannot notice that the successor was staffed into or out of a room
-- between the preview and the apply: the Owner would approve one set and a different set
-- would be revoked, with no refusal. The digest is recomputed under the target's row lock
-- before the demotion, and a mismatch is 40001.
CREATE TABLE ownership_transfer_preview (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{32}$'),
  actor_id text NOT NULL REFERENCES member(id),
  target_id text NOT NULL REFERENCES member(id),
  target_revision integer NOT NULL CHECK (target_revision > 0),
  target_assignment_digest char(64) NOT NULL
    CHECK (target_assignment_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);
COMMENT ON TABLE ownership_transfer_preview IS
  'One-time server-issued evidence that the required ownership dry run occurred, bound to actor, target, and target revision. Holds no personal data: the rendered impact is returned to the caller and not stored.';
CREATE INDEX ownership_transfer_preview_actor ON ownership_transfer_preview (actor_id, created_at);

-- A constant, so the client can display the exact phrase the server will compare
-- against instead of holding its own copy that could drift.
CREATE FUNCTION ownership_transfer_confirmation() RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT 'TRANSFER OWNERSHIP'::text
$$;


CREATE FUNCTION member_assignment_impact(p_member_id text)
RETURNS TABLE(digest text, total integer, rooms jsonb, truncated boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH held AS (
    SELECT a.id, a.room_id, a.room_role, r.title
    FROM room_assignment a
    JOIN room r ON r.id = a.room_id
    WHERE a.member_id = p_member_id AND a.state = 'active'
  ),
  disclosed AS (
    SELECT h.room_id, h.room_role, h.title
    FROM held h
    ORDER BY h.title, h.room_id
    LIMIT 100
  )
  SELECT
    encode(
      sha256(convert_to(
        coalesce(
          (SELECT string_agg(h.id || ':' || h.room_id || ':' || h.room_role, E'\n'
                             ORDER BY h.room_id)
           FROM held h),
          ''
        ),
        'UTF8'
      )),
      'hex'
    ),
    (SELECT count(*)::integer FROM held),
    coalesce(
      (SELECT jsonb_agg(
         jsonb_build_object('roomId', d.room_id, 'roomTitle', d.title, 'roomRole', d.room_role)
         ORDER BY d.title, d.room_id
       ) FROM disclosed d),
      '[]'::jsonb
    ),
    (SELECT count(*) FROM held) > (SELECT count(*) FROM disclosed)
$$;


CREATE FUNCTION dry_run_ownership_transfer(
  p_preview_id text,
  p_target_id text,
  p_actor_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  target_display text;
  target_role text;
  target_state text;
  target_revision integer;
  assignments record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM member
    WHERE id = p_actor_id AND state = 'active' AND global_role = 'owner'
  ) THEN
    RAISE EXCEPTION 'ownership transfer is Owner-only' USING ERRCODE = '42501';
  END IF;
  IF p_target_id = p_actor_id THEN
    RAISE EXCEPTION 'target cannot receive ownership' USING ERRCODE = '42501';
  END IF;
  SELECT email_display, global_role, state, revision
    INTO target_display, target_role, target_state, target_revision
  FROM member WHERE id = p_target_id FOR UPDATE;
  IF target_display IS NULL OR target_state <> 'active' OR target_role = 'owner' THEN
    RAISE EXCEPTION 'target cannot receive ownership' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO assignments FROM member_assignment_impact(p_target_id);
  INSERT INTO ownership_transfer_preview (
    id, actor_id, target_id, target_revision, target_assignment_digest, expires_at
  ) VALUES (
    p_preview_id, p_actor_id, p_target_id, target_revision, assignments.digest,
    statement_timestamp() + interval '15 minutes'
  );
  RETURN jsonb_build_object(
    'previewId', p_preview_id,
    'expectedRevision', target_revision,
    'targetEmailDisplay', target_display,
    'confirmation', ownership_transfer_confirmation(),
    'message', 'You become an Admin, the named member becomes Owner, and both of you are signed out of every device because privileges changed.',
    'revokedAssignmentCount', assignments.total,
    'revokedAssignments', assignments.rooms,
    'revokedAssignmentsTruncated', assignments.truncated
  );
END $$;


CREATE FUNCTION transfer_ownership(
  p_target_id text,
  p_actor_id text,
  p_expected_revision integer,
  p_oidc_authenticated_at timestamptz,
  p_preview_id text,
  p_confirmation text,
  p_audit_id text,
  p_correlation_id text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  preview ownership_transfer_preview;
  target_role text;
  target_state text;
  target_revision integer;
  current_assignment_digest text;
  promoted integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM member
    WHERE id = p_actor_id AND state = 'active' AND global_role = 'owner'
  ) THEN
    RAISE EXCEPTION 'ownership transfer is Owner-only' USING ERRCODE = '42501';
  END IF;
  IF p_oidc_authenticated_at IS NULL
     OR p_oidc_authenticated_at > statement_timestamp()
     OR p_oidc_authenticated_at <= statement_timestamp() - interval '15 minutes' THEN
    RAISE EXCEPTION 'fresh OIDC required' USING ERRCODE = '42501';
  END IF;
  IF p_confirmation IS DISTINCT FROM ownership_transfer_confirmation() THEN
    RAISE EXCEPTION 'typed confirmation mismatch' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO preview FROM ownership_transfer_preview
  WHERE id = p_preview_id FOR UPDATE;
  IF preview.id IS NULL
     OR preview.actor_id <> p_actor_id
     OR preview.target_id <> p_target_id
     OR preview.consumed_at IS NOT NULL
     OR preview.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'ownership preview required' USING ERRCODE = '42501';
  END IF;
  IF preview.target_revision <> p_expected_revision THEN
    RAISE EXCEPTION 'stale member revision' USING ERRCODE = '40001';
  END IF;
  UPDATE ownership_transfer_preview SET consumed_at = statement_timestamp()
  WHERE id = p_preview_id;
  PERFORM 1 FROM member
  WHERE id = p_actor_id AND state = 'active' AND global_role = 'owner' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ownership transfer is Owner-only' USING ERRCODE = '42501';
  END IF;
  SELECT global_role, state, revision INTO target_role, target_state, target_revision
  FROM member WHERE id = p_target_id FOR UPDATE;
  IF target_role IS NULL OR target_role = 'owner' OR target_state <> 'active' THEN
    RAISE EXCEPTION 'target cannot receive ownership' USING ERRCODE = '42501';
  END IF;
  IF target_revision <> p_expected_revision THEN
    RAISE EXCEPTION 'stale member revision' USING ERRCODE = '40001';
  END IF;
  SELECT digest INTO current_assignment_digest FROM member_assignment_impact(p_target_id);
  IF current_assignment_digest <> preview.target_assignment_digest THEN
    RAISE EXCEPTION 'stale successor assignments' USING ERRCODE = '40001';
  END IF;
  -- ORDER IS LOAD-BEARING. one_active_owner is a PARTIAL UNIQUE INDEX, which cannot be
  -- deferred and is checked immediately, so two active owners may not coexist even for a
  -- single statement. exactly_one_owner_after_member is DEFERRABLE INITIALLY DEFERRED and
  -- is checked at COMMIT, so zero owners in between is legal. Demote, then promote; the
  -- reverse order raises 23505.
  --
  -- Neither UPDATE carries a guard. The actor's row was locked and re-checked above, and
  -- the target's row was locked and its revision compared, so no other transaction can
  -- change either between those checks and here -- which is what the locks are for. A
  -- guard that cannot fire is not defence in depth; it is a claim that the lock is
  -- insufficient, and the next reader has to work out which is true.
  UPDATE member SET global_role = 'admin', revision = revision + 1
  WHERE id = p_actor_id;
  UPDATE member SET global_role = 'owner', revision = revision + 1
  WHERE id = p_target_id
  RETURNING revision INTO promoted;
  PERFORM supersede_room_assignments_for_role(
    p_target_id, p_actor_id, 'owner', p_correlation_id
  );
  INSERT INTO audit_event (
    id, event_type, actor_kind, actor_id, subject_id, resource_type, resource_id,
    result, reason_code, correlation_id, detail
  ) VALUES (
    p_audit_id, 'ownership.transferred', 'member', p_actor_id, p_target_id, 'member',
    p_target_id, 'success', 'OWNERSHIP_TRANSFERRED', p_correlation_id,
    jsonb_build_object('previewId', p_preview_id, 'revision', promoted)
  );
END $$;

-- Consumed and lapsed previews are removed rather than retained: a preview is one-time
-- evidence, and a consumed row is spent. Worker-only, and scheduled by the
-- `ownership.preview.purge` job seeded below.
CREATE FUNCTION purge_ownership_transfer_previews() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE removed integer;
BEGIN
  WITH gone AS (
    DELETE FROM ownership_transfer_preview
    WHERE consumed_at IS NOT NULL OR expires_at <= statement_timestamp()
    RETURNING 1
  )
  SELECT count(*) INTO removed FROM gone;
  RETURN removed;
END $$;


CREATE FUNCTION apply_room_assignments(
  p_member_id text,
  p_assign jsonb,
  p_revoke jsonb,
  p_actor_id text,
  p_audit_id text,
  p_correlation_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  target_role text;
  target_state text;
  inserted integer;
  updated integer;
  revoked integer;
  changed integer;
  resulting jsonb;
  resulting_count integer;
BEGIN
  PERFORM assert_organization_administrator(p_actor_id);
  IF p_assign IS NULL OR p_revoke IS NULL
     OR jsonb_typeof(p_assign) <> 'array' OR jsonb_typeof(p_revoke) <> 'array' THEN
    RAISE EXCEPTION 'assignment batch must be two arrays' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_assign) + jsonb_array_length(p_revoke) > 100 THEN
    RAISE EXCEPTION 'assignment batch too large' USING ERRCODE = '22023';
  END IF;
  IF p_member_id = p_actor_id THEN
    RAISE EXCEPTION 'self room assignment forbidden' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_assign) AS elements(value)
    WHERE jsonb_typeof(value) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(value)) <> 2
       OR NOT (value ? 'roomId' AND value ? 'roomRole')
  ) THEN
    RAISE EXCEPTION 'invalid assignment entry' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_assign) AS entry("roomId" text, "roomRole" text)
    WHERE entry."roomId" IS NULL OR entry."roomId" !~ '^[A-Za-z0-9_-]{32}$'
       OR entry."roomRole" IS NULL OR entry."roomRole" NOT IN ('manager', 'contributor')
  ) THEN
    RAISE EXCEPTION 'invalid assignment entry' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_revoke) AS elements(value)
    WHERE jsonb_typeof(value) <> 'string' OR (value #>> '{}') !~ '^[A-Za-z0-9_-]{32}$'
  ) THEN
    RAISE EXCEPTION 'invalid revocation entry' USING ERRCODE = '22023';
  END IF;

  IF (SELECT count(DISTINCT entry."roomId")
      FROM jsonb_to_recordset(p_assign) AS entry("roomId" text, "roomRole" text))
     <> jsonb_array_length(p_assign) THEN
    RAISE EXCEPTION 'duplicate room in assignment batch' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(DISTINCT value #>> '{}')
      FROM jsonb_array_elements(p_revoke) AS elements(value))
     <> jsonb_array_length(p_revoke) THEN
    RAISE EXCEPTION 'duplicate room in revocation batch' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_assign) AS entry("roomId" text, "roomRole" text)
    JOIN jsonb_array_elements(p_revoke) AS elements(value)
      ON entry."roomId" = value #>> '{}'
  ) THEN
    RAISE EXCEPTION 'room both assigned and revoked' USING ERRCODE = '22023';
  END IF;

  SELECT global_role, state INTO target_role, target_state
  FROM member WHERE id = p_member_id FOR UPDATE;
  IF target_role IS NULL OR target_state <> 'active' OR target_role <> 'member' THEN
    RAISE EXCEPTION 'member not assignable' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM (
      SELECT entry."roomId" AS room_id
      FROM jsonb_to_recordset(p_assign) AS entry("roomId" text, "roomRole" text)
      UNION
      SELECT value #>> '{}' FROM jsonb_array_elements(p_revoke) AS elements(value)
    ) wanted
    WHERE NOT EXISTS (SELECT 1 FROM room WHERE room.id = wanted.room_id)
  ) THEN
    RAISE EXCEPTION 'room not found' USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM room_assignment
  WHERE member_id = p_member_id AND state = 'active'
  ORDER BY room_id FOR UPDATE;

  WITH fresh AS (
    INSERT INTO room_assignment (id, room_id, member_id, room_role)
    SELECT replace(gen_random_uuid()::text, '-', ''), b."roomId", p_member_id, b."roomRole"
    FROM jsonb_to_recordset(p_assign) AS b("roomId" text, "roomRole" text)
    WHERE NOT EXISTS (
      SELECT 1 FROM room_assignment held
      WHERE held.room_id = b."roomId" AND held.member_id = p_member_id
        AND held.state = 'active'
    )
    RETURNING 1
  )
  SELECT count(*) INTO inserted FROM fresh;

  WITH rerole AS (
    UPDATE room_assignment held
    SET room_role = b."roomRole"
    FROM jsonb_to_recordset(p_assign) AS b("roomId" text, "roomRole" text)
    WHERE held.room_id = b."roomId" AND held.member_id = p_member_id
      AND held.state = 'active' AND held.room_role <> b."roomRole"
    RETURNING 1
  )
  SELECT count(*) INTO updated FROM rerole;

  WITH withdrawn AS (
    UPDATE room_assignment held
    SET state = 'revoked'
    FROM jsonb_array_elements(p_revoke) AS elements(value)
    WHERE held.room_id = value #>> '{}' AND held.member_id = p_member_id
      AND held.state = 'active'
    RETURNING 1
  )
  SELECT count(*) INTO revoked FROM withdrawn;

  changed := inserted + updated + revoked;
  IF changed = 0 THEN
    RAISE EXCEPTION 'assignment batch changes nothing' USING ERRCODE = '22023';
  END IF;

  SELECT
    coalesce(
      jsonb_agg(
        jsonb_build_object('roomId', a.room_id, 'roomRole', a.room_role) ORDER BY a.room_id
      ),
      '[]'::jsonb
    ),
    count(*)
  INTO resulting, resulting_count
  FROM room_assignment a
  WHERE a.member_id = p_member_id AND a.state = 'active';
  IF resulting_count > 500 THEN
    RAISE EXCEPTION 'member holds too many room assignments' USING ERRCODE = '22023';
  END IF;

  INSERT INTO audit_event (
    id, event_type, actor_kind, actor_id, subject_id, resource_type, resource_id,
    result, reason_code, correlation_id, detail
  ) VALUES (
    p_audit_id, 'room.assignment', 'member', p_actor_id, p_member_id, 'member', p_member_id,
    'success', 'ROOM_ASSIGNMENTS_APPLIED', p_correlation_id,
    jsonb_build_object('assigned', p_assign, 'revoked', p_revoke, 'changed', changed)
  );
  RETURN jsonb_build_object(
    'memberId', p_member_id, 'changed', changed, 'assignments', resulting
  );
END $$;
-- The purge sweep, scheduled the way 010's export cleanup is: one seeded row, and the
-- handler re-arms itself under its own lease. Without a scheduled caller the previews
-- would accumulate and the claim that a consumed preview is removed would be false.
INSERT INTO job_queue (id, job_type, idempotency_key, payload, available_at, max_attempts)
VALUES (
  replace(gen_random_uuid()::text, '-', ''), 'ownership.preview.purge',
  'ownership-preview-purge:initial', '{}'::jsonb,
  statement_timestamp() + interval '1 hour', 10
);

-- TABLE PRIVILEGES.
--
-- Narrowed from what 001 granted, so identity and room privilege are reachable only
-- through the functions above. The escalation each revocation closes:
--
-- * `invitation` -- an application role able to write `intended_global_role` could turn a
--   pending Member invitation into an Admin one before acceptance, and acceptance would
--   audit the elevated role as though it had been authorized. `duefold_authenticator`
--   keeps SELECT only: `accept_member_invitation` performs the acceptance write, so no
--   credential needs UPDATE on the state column either.
-- * `room_assignment` -- direct DML would create room access with no audit row and no
--   session revocation, which is an unaudited grant.
-- * `member` -- `duefold_runtime` and `duefold_worker` never wrote it. The authenticator
--   did, for the first-owner bootstrap and OIDC acceptance; both now call a function, so
--   it holds SELECT alone. CLI owner recovery runs on the migration role, not this one.
REVOKE ALL ON invitation FROM duefold_runtime, duefold_authenticator, duefold_worker;
GRANT SELECT ON invitation TO duefold_authenticator;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON room_assignment
  FROM duefold_runtime, duefold_authenticator, duefold_worker;
GRANT SELECT ON room_assignment TO duefold_runtime, duefold_authenticator;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON member
  FROM duefold_runtime, duefold_worker, duefold_authenticator;

ALTER TABLE ownership_transfer_preview OWNER TO duefold_migration;
REVOKE ALL ON ownership_transfer_preview
  FROM PUBLIC,duefold_runtime,duefold_worker,duefold_authenticator;

-- FUNCTION PRIVILEGES.
--
-- Revoked from PUBLIC and from every application role first, then granted back to the one
-- role that needs each. PostgreSQL grants EXECUTE to PUBLIC by default, so a function
-- created without this is callable by every role in the installation regardless of what
-- it checks inside.
REVOKE ALL ON FUNCTION assert_organization_administrator(text)
  FROM PUBLIC,duefold_runtime,duefold_worker,duefold_authenticator;
REVOKE ALL ON FUNCTION cancel_member_invitation_mail(text)
  FROM PUBLIC,duefold_runtime,duefold_worker,duefold_authenticator;
REVOKE ALL ON FUNCTION supersede_room_assignments_for_role(text,text,text,text)
  FROM PUBLIC,duefold_runtime,duefold_worker,duefold_authenticator;
REVOKE ALL ON FUNCTION member_subject_capabilities(text,text)
  FROM PUBLIC,duefold_runtime,duefold_worker,duefold_authenticator;
REVOKE ALL ON FUNCTION ownership_transfer_confirmation()
  FROM PUBLIC,duefold_runtime,duefold_worker,duefold_authenticator;
REVOKE ALL ON FUNCTION member_assignment_impact(text)
  FROM PUBLIC,duefold_runtime,duefold_worker,duefold_authenticator;
REVOKE ALL ON FUNCTION invite_member(text,text,text,text,text,text,text,text)
  FROM PUBLIC,duefold_runtime,duefold_worker,duefold_authenticator;
REVOKE ALL ON FUNCTION revoke_member_invitation(text,text,text,text)
  FROM PUBLIC,duefold_runtime,duefold_worker,duefold_authenticator;
REVOKE ALL ON FUNCTION accept_member_invitation(text,text,text,text,text,text,text,text)
  FROM PUBLIC,duefold_runtime,duefold_worker,duefold_authenticator;
REVOKE ALL ON FUNCTION claim_first_owner(text,text,text,text,text,text,text,text,text)
  FROM PUBLIC,duefold_runtime,duefold_worker,duefold_authenticator;
REVOKE ALL ON FUNCTION read_members(text,timestamptz,text,integer)
  FROM PUBLIC,duefold_runtime,duefold_worker,duefold_authenticator;
REVOKE ALL ON FUNCTION may_administer_organization(text)
  FROM PUBLIC,duefold_runtime,duefold_worker,duefold_authenticator;
REVOKE ALL ON FUNCTION read_member_invitation_mail(text,text,text,text)
  FROM PUBLIC,duefold_runtime,duefold_worker,duefold_authenticator;
REVOKE ALL ON FUNCTION set_member_global_role(text,text,text,integer,text,text)
  FROM PUBLIC,duefold_runtime,duefold_worker,duefold_authenticator;
REVOKE ALL ON FUNCTION set_member_state(text,text,text,integer,text,text)
  FROM PUBLIC,duefold_runtime,duefold_worker,duefold_authenticator;
REVOKE ALL ON FUNCTION dry_run_ownership_transfer(text,text,text)
  FROM PUBLIC,duefold_runtime,duefold_worker,duefold_authenticator;
REVOKE ALL ON FUNCTION transfer_ownership(text,text,integer,timestamptz,text,text,text,text)
  FROM PUBLIC,duefold_runtime,duefold_worker,duefold_authenticator;
REVOKE ALL ON FUNCTION purge_ownership_transfer_previews()
  FROM PUBLIC,duefold_runtime,duefold_worker,duefold_authenticator;
REVOKE ALL ON FUNCTION apply_room_assignments(text,jsonb,jsonb,text,text,text)
  FROM PUBLIC,duefold_runtime,duefold_worker,duefold_authenticator;

GRANT EXECUTE ON FUNCTION invite_member(text,text,text,text,text,text,text,text)
  TO duefold_runtime;
GRANT EXECUTE ON FUNCTION revoke_member_invitation(text,text,text,text)
  TO duefold_runtime;
GRANT EXECUTE ON FUNCTION read_members(text,timestamptz,text,integer)
  TO duefold_runtime;
GRANT EXECUTE ON FUNCTION may_administer_organization(text)
  TO duefold_runtime;
GRANT EXECUTE ON FUNCTION set_member_global_role(text,text,text,integer,text,text)
  TO duefold_runtime;
GRANT EXECUTE ON FUNCTION set_member_state(text,text,text,integer,text,text)
  TO duefold_runtime;
GRANT EXECUTE ON FUNCTION dry_run_ownership_transfer(text,text,text)
  TO duefold_runtime;
GRANT EXECUTE ON FUNCTION transfer_ownership(text,text,integer,timestamptz,text,text,text,text)
  TO duefold_runtime;
GRANT EXECUTE ON FUNCTION apply_room_assignments(text,jsonb,jsonb,text,text,text)
  TO duefold_runtime;
-- The two provisioning paths belong to the OIDC callback, which runs on the
-- authenticator credential before any session exists.
GRANT EXECUTE ON FUNCTION accept_member_invitation(text,text,text,text,text,text,text,text)
  TO duefold_authenticator;
GRANT EXECUTE ON FUNCTION claim_first_owner(text,text,text,text,text,text,text,text,text)
  TO duefold_authenticator;
GRANT EXECUTE ON FUNCTION read_member_invitation_mail(text,text,text,text)
  TO duefold_worker;
GRANT EXECUTE ON FUNCTION purge_ownership_transfer_previews()
  TO duefold_worker;

ALTER FUNCTION assert_organization_administrator(text) OWNER TO duefold_migration;
ALTER FUNCTION cancel_member_invitation_mail(text) OWNER TO duefold_migration;
ALTER FUNCTION supersede_room_assignments_for_role(text,text,text,text)
  OWNER TO duefold_migration;
ALTER FUNCTION member_subject_capabilities(text,text) OWNER TO duefold_migration;
ALTER FUNCTION ownership_transfer_confirmation() OWNER TO duefold_migration;
ALTER FUNCTION member_assignment_impact(text) OWNER TO duefold_migration;
ALTER FUNCTION invite_member(text,text,text,text,text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION revoke_member_invitation(text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION accept_member_invitation(text,text,text,text,text,text,text,text)
  OWNER TO duefold_migration;
ALTER FUNCTION claim_first_owner(text,text,text,text,text,text,text,text,text)
  OWNER TO duefold_migration;
ALTER FUNCTION read_members(text,timestamptz,text,integer) OWNER TO duefold_migration;
ALTER FUNCTION may_administer_organization(text) OWNER TO duefold_migration;
ALTER FUNCTION read_member_invitation_mail(text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION set_member_global_role(text,text,text,integer,text,text) OWNER TO duefold_migration;
ALTER FUNCTION set_member_state(text,text,text,integer,text,text) OWNER TO duefold_migration;
ALTER FUNCTION dry_run_ownership_transfer(text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION transfer_ownership(text,text,integer,timestamptz,text,text,text,text)
  OWNER TO duefold_migration;
ALTER FUNCTION purge_ownership_transfer_previews() OWNER TO duefold_migration;
ALTER FUNCTION apply_room_assignments(text,jsonb,jsonb,text,text,text) OWNER TO duefold_migration;
