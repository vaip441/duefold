-- Duefold organization administration. This migration is immutable after application.
--
-- Member invitations carry the role granted at acceptance. Invitation creation,
-- revocation, and the mail projection remain behind narrow SECURITY DEFINER
-- boundaries so the web and worker roles do not gain direct identity access.
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

-- 001 declared UNIQUE (kind, email_key, state), which also limits an address to a
-- single terminal row. That made the invitation lifecycle a one-shot: after one
-- invite/revoke cycle a second revocation of the same address failed on the
-- unique constraint, leaving an invitation that could be created but never
-- withdrawn. The live-state halves of that constraint are restated as partial
-- unique indexes so terminal history accumulates while at most one pending and
-- one accepted invitation per kind and address remain enforced, unchanged.
ALTER TABLE invitation DROP CONSTRAINT invitation_kind_email_key_state_key;
CREATE UNIQUE INDEX one_pending_invitation
  ON invitation (kind, email_key)
  WHERE state = 'pending';
CREATE UNIQUE INDEX one_accepted_invitation
  ON invitation (kind, email_key)
  WHERE state = 'accepted';

-- An address must not be re-invitable while a member already holds it, and a
-- revoked room assignment must remain on record. 001's UNIQUE (room_id, member_id)
-- spanned every state, so the only way to re-staff a member was to delete the
-- revoked row -- destroying the terminal history the design requires to stay
-- reconstructable. The uniqueness that actually matters is "at most one ACTIVE
-- assignment per room and member", so it is restated as a partial unique index and
-- revoked rows accumulate beside it.
ALTER TABLE room_assignment DROP CONSTRAINT room_assignment_room_id_member_id_key;
CREATE UNIQUE INDEX one_active_room_assignment
  ON room_assignment (room_id, member_id)
  WHERE state = 'active';
-- Every reader added here answers "what does THIS member hold", which 001's
-- (room_id, member_id) order cannot serve without scanning the table.
CREATE INDEX active_room_assignment_member
  ON room_assignment (member_id)
  WHERE state = 'active';
-- Every reader that resolves a room role must now say which state it means.
-- read_member_rooms joined room_assignment without filtering state, so a member
-- whose assignment had been revoked was still listed with that role and
-- access_source='assignment'. That was already wrong before this migration -- a
-- revoked Manager kept a Manager badge -- and with terminal rows now accumulating
-- it would compound. member_can_mutate_room decides reachability; this reader only
-- explains it, so the join is corrected to the active row.
CREATE OR REPLACE FUNCTION read_member_rooms(p_actor_id text)
RETURNS TABLE(room_id text,title text,description text,state text,revision integer,
  working_revision integer,published_revision integer,room_role text,access_source text,
  can_publish boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT r.id,r.title,r.description,r.state,r.revision,r.working_revision,r.published_revision,
    a.room_role,
    CASE WHEN a.room_role IS NOT NULL THEN 'assignment' ELSE 'global_role' END,
    member_can_mutate_room(p_actor_id,r.id,true)
  FROM room r
  LEFT JOIN room_assignment a
    ON a.room_id=r.id AND a.member_id=p_actor_id AND a.state='active'
  WHERE member_can_mutate_room(p_actor_id,r.id,false)
  ORDER BY r.title,r.id
$$;
ALTER FUNCTION read_member_rooms(text) OWNER TO duefold_migration;

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

-- Terminalizing an invitation makes its queued onboarding mail obsolete. Without
-- this the job stays pending, the lease-gated projection correctly returns no
-- row, and the handler would retry to a terminal failed job -- reporting a
-- required-mail failure for mail that must deliberately never be sent.
--
-- Only a still-pending job is withdrawn. A job already leased to a worker is
-- left alone because deleting a running row would strip the fencing evidence the
-- worker re-checks; that worker instead observes the terminal invitation through
-- the projection and completes as an intentional no-op.
CREATE FUNCTION cancel_member_invitation_mail(p_invitation_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  DELETE FROM job_queue
  WHERE job_type = 'mail.member_invitation'
    AND payload->>'invitationId' = p_invitation_id
    AND state = 'pending';
END $$;

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
  -- The key authorizes acceptance and the display value receives the required
  -- onboarding mail, so they must name the same address. Validating only the
  -- display length would let an invitation admit one address while its mail is
  -- delivered to another. Derived with the same expression canonical_email_key
  -- asserts, so there is one normalization contract rather than two.
  IF p_email_key IS NULL OR NOT canonical_email_key(p_email_key)
     OR p_email_display IS NULL OR length(p_email_display) NOT BETWEEN 3 AND 320
     OR normalize(lower(btrim(p_email_display)), NFC) <> p_email_key
     OR p_email_display <> normalize(btrim(p_email_display), NFC) THEN
    RAISE EXCEPTION 'invalid invitation email' USING ERRCODE = '22023';
  END IF;
  -- A disabled identity is re-enabled through member administration; accepting a
  -- second identity with the same email would fail the member uniqueness boundary.
  IF EXISTS (SELECT 1 FROM member WHERE email_key = p_email_key) THEN
    RAISE EXCEPTION 'member already exists' USING ERRCODE = '23505';
  END IF;
  -- A pending invitation past its expiry is already invisible to read_members and
  -- so cannot be withdrawn from the surface. Left pending it would block the
  -- address permanently, so it is closed here before a fresh invitation is issued.
  -- Expiry is a terminal invitation lifecycle state, so it carries its own audit
  -- event naming the affected invitation; the replacement's invitation.created
  -- row identifies only the new invitation and cannot stand in for it (§15.1).
  UPDATE invitation
  SET state = 'expired'
  WHERE kind = 'member'
    AND email_key = p_email_key
    AND state = 'pending'
    AND expires_at <= statement_timestamp()
  RETURNING id INTO lapsed_id;
  IF lapsed_id IS NOT NULL THEN
    INSERT INTO audit_event (
      id, event_type, actor_kind, actor_id, resource_type, resource_id,
      result, reason_code, correlation_id, detail
    ) VALUES (
      replace(gen_random_uuid()::text, '-', ''), 'invitation.expired', 'member', p_actor_id,
      'invitation', lapsed_id, 'success', 'MEMBER_INVITATION_EXPIRED', p_correlation_id,
      jsonb_build_object('supersededBy', p_id)
    );
    PERFORM cancel_member_invitation_mail(lapsed_id);
  END IF;
  -- Stated explicitly rather than left to one_pending_invitation so an Admin
  -- inviting an already-invited address is refused by this boundary; the index
  -- remains the backstop for two concurrent invitations of the same address.
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

-- Invited people have no member row until OIDC acceptance, so this projection
-- explicitly distinguishes pending invitations from provisioned members.
--
-- Members and pending invitations are both growing collections, so the reader is
-- keyset-paged rather than a full projection (§23: no unbounded query, keyset
-- pagination for growing collections). The cursor is (created_at, subject_id)
-- descending, which is total: created_at alone is not unique, and paging on it
-- alone would skip or repeat rows sharing an instant.
--
-- `cursor_created_at` is the exact textual timestamp and is what a caller must echo.
-- timestamptz holds microseconds while several client languages -- including this
-- project's -- carry only milliseconds, so a caller that round-tripped the display
-- value would send back a truncated instant. Truncation moves the cursor EARLIER
-- than the row it came from, and in descending order that silently skips every row
-- tied at that microsecond. Emitting the exact text keeps paging lossless without
-- asking the client to hold a precision it does not have.
--
-- EVERY SUBJECT THIS RETURNS CARRIES ITS COMPLETE ACTIVE ASSIGNMENT SET.
--
-- Assignments used to be a second, separately paged projection, and a page that hit
-- the assignment bound reported one truthful-but-useless flag: "something on this
-- page is incomplete". A surface could not tell WHICH member's room list was short,
-- and a short room list reads as the member's whole access -- a false access claim --
-- with no bounded route to recover the rest. So the bound moved off the assignment
-- set and onto the SUBJECT PAGE: rooms are a growing collection with no installation
-- cap (§23), so this returns the longest PREFIX of the page whose members' complete
-- assignment sets fit the row budget, and the ordinary keyset cursor reaches the
-- remainder. A page may therefore be shorter than p_limit and still continue, which
-- is why `continues` is reported rather than inferred from the row count.
--
-- Both the work and the result stay bounded. The budget probe reads at most
-- budget + 1 assignment rows in total -- not per member -- and is used only to locate
-- the first subject the page cannot afford; the arrays themselves are then aggregated
-- for the admitted prefix alone.
--
-- The first subject is always admitted, so a page is never empty while subjects
-- remain and the walk always progresses. That stays bounded because
-- apply_room_assignments caps ONE member at 500 active assignments, which is the
-- budget, so one subject's complete set always fits. A member somehow holding more is
-- still returned complete rather than truncated, and the route's own per-subject
-- bound then rejects the response as a fault instead of rendering a partial set as
-- whole.
--
-- One statement, so the subjects and their assignments come from ONE snapshot. Two
-- readers could not promise that: a batch committing between them produced a page
-- whose room lists belonged to a different instant than its members.
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
  continues boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  -- Assignment rows one page may carry across every subject on it. Equal to the
  -- per-member cap apply_room_assignments enforces, which is what makes "always
  -- admit the first subject" a bounded promise rather than an escape hatch.
  budget constant integer := 500;
BEGIN
  PERFORM assert_organization_administrator(p_actor_id);
  -- The client-visible bound, enforced here because the route is not the authority.
  -- The extra CONTINUATION PROBE row is this function's own business: emitting a
  -- cursor merely because a page was full advertised another page for a collection
  -- whose size is an exact multiple of the limit, so the probe proves continuation
  -- and is never returned.
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
    -- One row past the budget, in page order. An invitation contributes nothing
    -- because an invited person has no member row until acceptance, so there is no
    -- assignment that could belong to them.
    probe AS (
      SELECT c.ordinal
      FROM candidates c
      JOIN room_assignment a
        ON a.member_id = c.subject_id AND a.state = 'active'
      WHERE c.subject_kind = 'member' AND c.ordinal <= p_limit
      ORDER BY c.ordinal, a.room_id
      LIMIT budget + 1
    ),
    -- The first subject the page cannot afford: the one owning the overflowing row.
    -- Absent when the whole page fits, because HAVING drops the group. Never 1,
    -- because the leading subject is always admitted so the walk cannot stall; that
    -- clamp is reachable only for a member holding more than the per-member cap,
    -- which the route then refuses as a fault rather than rendering short.
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
           -- Stated, not inferred: a page cut short by the assignment budget is
           -- shorter than p_limit and still continues, so a client that guessed from
           -- the row count would stop early and call a partial list complete.
           EXISTS (
             SELECT 1 FROM candidates rest
             WHERE rest.ordinal > (SELECT max(kept.ordinal) FROM admitted kept)
           )
    FROM admitted a
    ORDER BY a.ordinal;
END $$;

-- A worker may learn an invitee address only while it holds the exact live job
-- lease. The address never appears in the job payload or telemetry.
--
-- The lease fence and the invitation's deliverability are reported separately so
-- the handler can tell two different situations apart: a worker without the live
-- lease gets no row at all and must fail, while a worker holding the lease for an
-- invitation that has since been revoked or expired gets a row with a null
-- address and completes as an intentional no-op instead of retrying to a
-- terminal failed job.
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

-- Member administration. Neither function can reach the Owner: ownership moves
-- only through transfer_ownership, so one audited path owns the single-owner
-- invariant and no role or state edit can approach it from the side.
--
-- Neither function lets an actor administer themselves. A self-demotion or
-- self-disable destroys the acting session mid-request through
-- member_privilege_session_revoke and silently reduces the installation's
-- administration capacity; the Owner is always available to do it instead, so the
-- capability is not lost, only the accident.
--
-- Both take the target's expected revision and lock the row before deciding, so
-- two administrators acting at the same instant cannot both write. A request that
-- would change nothing is refused rather than recorded: an audit row reading
-- "admin to admin" is evidence of a change that never happened, and the revision
-- bump would invalidate every other client's view for no reason.
-- Promotion out of 'member' supersedes that member's explicit room assignments.
--
-- §4.2 gives Owners and Admins Room Manager authority in every room, and only
-- Members receive explicit assignments -- which is exactly what
-- apply_room_assignments enforces on its target. Leaving the rows behind broke that
-- rule from the other direction: the member list advertised a narrower
-- 'contributor' row on someone who actually held standing Manager rights, and a
-- later demotion made those stale rows authorization-effective again with no
-- room.assignment mutation and no audit row naming the change.
--
-- Revoking is chosen over refusing the promotion. Refusing would make routine
-- administration a two-step dance whose first step is unrelated to the
-- administrator's intent, and the rows carry no authority the promotion does not
-- already grant, so removing them takes nothing away. The effect is recorded as its
-- own room.assignment event because a privilege set changed and §15.1 requires the
-- spine to name it; the caller's member.role or ownership.transferred row shares the
-- correlation id, so the two read as one action.
--
-- The caller holds the target's member row lock, so the assignment set cannot move
-- under this. Revocation sets state and never deletes, matching
-- apply_room_assignments, so the terminal history stays reconstructable.
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
  -- An absent member and the Owner share one refusal so a denial cannot be used
  -- to discover which member ids exist.
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
  WHERE id = p_target_id AND revision = p_expected_revision
  RETURNING revision INTO next_revision;
  IF next_revision IS NULL THEN
    RAISE EXCEPTION 'stale member revision' USING ERRCODE = '40001';
  END IF;
  -- Promotion out of 'member' supersedes explicit assignments; see the helper. A
  -- demotion to 'member' is the reverse direction and grants nothing, so it leaves
  -- the (already empty) active set alone.
  IF p_role <> 'member' THEN
    PERFORM supersede_room_assignments_for_role(
      p_target_id, p_actor_id, p_role, p_correlation_id
    );
  END IF;
  -- Sessions are not revoked here. member_privilege_session_revoke in 001 already
  -- revokes every active session of a member whose global_role or state changed,
  -- and it is the one place that decides it; a second revocation written here
  -- would be a parallel rule that could drift from the kernel's.
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
  -- Disabling the Owner would leave the installation with no active Owner and
  -- surface as a deferred constraint-trigger violation at COMMIT, which no
  -- surface can explain. Refused here with a reason the UI can state.
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
  WHERE id = p_target_id AND revision = p_expected_revision
  RETURNING revision INTO next_revision;
  IF next_revision IS NULL THEN
    RAISE EXCEPTION 'stale member revision' USING ERRCODE = '40001';
  END IF;
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

-- Ownership transfer is gated on a server-issued preview, not on a string.
--
-- The confirmation phrase is constant and publicly documented, so comparing a
-- caller's input against it proved only that the caller could read the docs: a
-- client could post 'TRANSFER OWNERSHIP' having never requested a preview, and
-- §9.4's dry-run requirement was decorative. The typed phrase remains -- it is the
-- deliberate human gate -- but apply now additionally consumes a one-time record
-- that only the dry run can create, bound to the actor, the target, and the
-- target's revision at preview time.
--
-- Rows are retained after consumption rather than deleted, so the evidence that a
-- preview preceded a transfer survives alongside the audit row.
CREATE TABLE ownership_transfer_preview (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{32}$'),
  actor_id text NOT NULL REFERENCES member(id),
  target_id text NOT NULL REFERENCES member(id),
  target_revision integer NOT NULL CHECK (target_revision > 0),
  /*
   * The successor's active assignment set at preview time, as a digest.
   *
   * member.revision does not move when a room_assignment row changes, so the
   * revision alone could not notice that the successor was staffed into or out of a
   * room between the preview and the apply. The Owner was shown "these rooms will be
   * revoked" and the transfer then revoked a different set with no refusal.
   * Recomputed under the target's row lock before the demotion; a mismatch is stale.
   */
  target_assignment_digest char(64) NOT NULL
    CHECK (target_assignment_digest ~ '^[a-f0-9]{64}$'),
  impact jsonb NOT NULL CHECK (jsonb_typeof(impact) = 'object'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);
COMMENT ON TABLE ownership_transfer_preview IS
  'One-time server-issued evidence that the required ownership dry run occurred, bound to actor, target, and target revision.';
CREATE INDEX ownership_transfer_preview_actor ON ownership_transfer_preview (actor_id, created_at);

-- The successor's active assignment set, as the ownership preview describes it and
-- as the apply re-checks it. One function so the two cannot compute it differently.
--
-- `digest` is over stable row identity and state -- assignment id, room, and role, in
-- room order -- so it changes when the set does and not otherwise. member.revision
-- does not move when a room_assignment row changes, so the revision the preview
-- already carried could not notice a successor being staffed into or out of a room
-- between preview and apply. Without this the Owner approved "these rooms will be
-- revoked" and the transfer silently revoked a different set.
--
-- `rooms` is bounded and `total` is exact. apply_room_assignments caps one member at
-- 500 active assignments, so the count cannot run away; the disclosed list is capped
-- lower because it also carries titles, and `truncated` says so rather than letting a
-- short list read as the whole impact. The member list returns any one subject's
-- COMPLETE set, so the remainder is reachable there rather than lost.
--
-- Titles are disclosed because this is Owner-only and §4.2 gives the Owner Room
-- Manager authority in every room, so no room here is one the caller could not
-- already open. Nothing beyond room identity and title is included.
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

-- Issues the preview and records it, deriving everything it discloses and everything
-- apply will later re-check from ONE snapshot taken under the target's row lock.
--
-- THE LOCK AND THE SINGLE SNAPSHOT ARE THE POINT. This used to read the disclosed
-- assignment list in one statement, the target's revision in a second, and the stored
-- digest in a third, with no lock spanning them. Under READ COMMITTED each statement
-- takes its own snapshot, so apply_room_assignments could commit in between: the Owner
-- was shown set A while the preview stored a digest for set B. Apply then locked the
-- target, recomputed the digest, found B, matched the stored value, and proceeded to
-- revoke assignments that were never disclosed. The exact-set fence §9.4 requires was
-- defeated by the very evidence meant to enforce it, and no amount of checking at apply
-- time could detect it, because by then both halves of the preview looked consistent.
--
-- The target's member row is the serialization point every assignment mutation already
-- takes: apply_room_assignments locks it before validating or writing anything, and
-- supersede_room_assignments_for_role runs under the caller's lock on it. Holding it
-- here therefore means no assignment of this member can change while the preview is
-- derived. member_assignment_impact is then called ONCE, so the disclosed rooms, the
-- exact count, the truncation flag, and the digest all come from that single statement's
-- snapshot and cannot describe different states.
--
-- ONLY THE TARGET IS LOCKED. The actor's Owner check stays an unlocked read because
-- transfer_ownership locks actor-then-target, and a dry run that also locked the actor
-- after the target would invert that order and could deadlock. The actor check here is
-- advisory in any case -- apply re-decides Owner authority under its own lock -- so the
-- narrower lock is both safer and sufficient.
--
-- ownership_transfer_impact used to hold the formatting half of this and was STABLE,
-- which is exactly why it could not take the lock. Folding it in leaves one function
-- that cannot be split back apart into two snapshots; it had no other caller.
--
-- The window matches the fresh-OIDC window, so a preview cannot outlive the
-- authentication that would be required to apply it.
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
  impact jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM member
    WHERE id = p_actor_id AND state = 'active' AND global_role = 'owner'
  ) THEN
    RAISE EXCEPTION 'ownership transfer is Owner-only' USING ERRCODE = '42501';
  END IF;
  -- The lock first, then every fact the preview rests on, all under it.
  SELECT email_display, global_role, state, revision
    INTO target_display, target_role, target_state, target_revision
  FROM member WHERE id = p_target_id FOR UPDATE;
  -- An absent member and an ineligible one share one refusal, so a denial cannot be
  -- used to discover which member ids exist.
  IF target_display IS NULL OR target_state <> 'active' OR target_role = 'owner' THEN
    RAISE EXCEPTION 'target cannot receive ownership' USING ERRCODE = '42501';
  END IF;
  -- Promotion to Owner supersedes the successor's explicit assignments (§4.2), so the
  -- dry run must NAME that consequence. A preview that described only the role change
  -- asked the Owner to approve a privilege revocation it never mentioned.
  --
  -- ONE call, ONE snapshot: the rooms the Owner reads and the digest apply re-checks
  -- are the same assignment state by construction rather than by coincidence.
  SELECT * INTO assignments FROM member_assignment_impact(p_target_id);
  impact := jsonb_build_object(
    'targetEmailDisplay', target_display,
    'confirmation', 'TRANSFER OWNERSHIP',
    'message', 'You become an Admin, the named member becomes Owner, and both of you are signed out of every device because privileges changed.',
    'revokedAssignmentCount', assignments.total,
    'revokedAssignments', assignments.rooms,
    'revokedAssignmentsTruncated', assignments.truncated
  );
  INSERT INTO ownership_transfer_preview (
    id, actor_id, target_id, target_revision, target_assignment_digest, impact, expires_at
  ) VALUES (
    p_preview_id, p_actor_id, p_target_id, target_revision, assignments.digest, impact,
    statement_timestamp() + interval '15 minutes'
  );
  RETURN impact || jsonb_build_object(
    'previewId', p_preview_id,
    'expectedRevision', target_revision
  );
END $$;

-- Ownership is a high-consequence change (§9.4): fresh OIDC, a dry run naming the
-- impact, typed confirmation, the target's expected revision, and mutation plus
-- audit in one transaction. Freshness is decided here rather than in the route,
-- because a route-side check is advisory and this one is authoritative; the
-- authentication instant is session-bound evidence the caller cannot forge.
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
  IF p_oidc_authenticated_at IS NULL
     OR p_oidc_authenticated_at > statement_timestamp()
     OR p_oidc_authenticated_at <= statement_timestamp() - interval '15 minutes' THEN
    RAISE EXCEPTION 'fresh OIDC required' USING ERRCODE = '42501';
  END IF;
  -- The preview is consumed under its own lock, so two applies cannot both spend
  -- one preview even if they arrive together.
  SELECT * INTO preview FROM ownership_transfer_preview
  WHERE id = p_preview_id FOR UPDATE;
  -- An absent, foreign, already-spent, or lapsed preview is one refusal: a caller
  -- that never previewed learns nothing about which preview ids exist.
  IF preview.id IS NULL
     OR preview.actor_id <> p_actor_id
     OR preview.target_id <> p_target_id
     OR preview.consumed_at IS NOT NULL
     OR preview.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'ownership preview required' USING ERRCODE = '42501';
  END IF;
  -- The preview named the revision it described. A target that changed since then
  -- means the Owner agreed to an impact that no longer holds.
  IF preview.target_revision <> p_expected_revision THEN
    RAISE EXCEPTION 'stale member revision' USING ERRCODE = '40001';
  END IF;
  -- Compared against the phrase the SERVER stored in this preview, not against a
  -- literal recomputed here.
  IF p_confirmation IS DISTINCT FROM preview.impact->>'confirmation' THEN
    RAISE EXCEPTION 'typed confirmation mismatch' USING ERRCODE = '22023';
  END IF;
  UPDATE ownership_transfer_preview SET consumed_at = statement_timestamp()
  WHERE id = p_preview_id;
  -- Both rows are locked, outgoing Owner first and successor second, so every
  -- caller takes them in one order and two transfers cannot deadlock. The dry run
  -- read them unlocked, so each condition is re-decided under the lock.
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
  -- The assignment set the Owner approved revoking, re-checked under the lock that
  -- now holds it still. member.revision does not move when a room_assignment row
  -- changes, so the revision check above cannot see this: without it, a concurrent
  -- assign-rooms between preview and apply meant the transfer revoked a set the
  -- Owner never saw. Reported as a conflict, so the Owner previews again and
  -- approves the impact that actually holds.
  SELECT digest INTO current_assignment_digest FROM member_assignment_impact(p_target_id);
  IF current_assignment_digest <> preview.target_assignment_digest THEN
    RAISE EXCEPTION 'stale successor assignments' USING ERRCODE = '40001';
  END IF;
  /* ORDER IS LOAD-BEARING. one_active_owner is a PARTIAL UNIQUE INDEX, which
   * cannot be deferred and is checked immediately, so two active owners may not
   * coexist even for a single statement. exactly_one_owner_after_member is
   * DEFERRABLE INITIALLY DEFERRED and is checked at COMMIT, so zero owners in
   * between is legal. Demote, then promote. The reverse order raises 23505. */
  UPDATE member SET global_role = 'admin', revision = revision + 1
  WHERE id = p_actor_id AND state = 'active' AND global_role = 'owner';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'outgoing owner changed concurrently' USING ERRCODE = '40001';
  END IF;
  UPDATE member SET global_role = 'owner', revision = revision + 1
  WHERE id = p_target_id AND state = 'active' AND revision = p_expected_revision
  RETURNING revision INTO promoted;
  IF promoted IS NULL THEN
    RAISE EXCEPTION 'stale member revision' USING ERRCODE = '40001';
  END IF;
  -- The successor becomes Owner, so any explicit assignment they held is superseded
  -- by the standing Room Manager authority ownership carries (§4.2). Same helper and
  -- same reasoning as set_member_global_role; the outgoing Owner is demoted to admin,
  -- which is still an administrator, so they gain no assignment either.
  PERFORM supersede_room_assignments_for_role(
    p_target_id, p_actor_id, 'owner', p_correlation_id
  );
  -- The detail names roles and revisions only. The target's address is in the dry
  -- run the Owner read, never in the spine (§20.3).
  INSERT INTO audit_event (
    id, event_type, actor_kind, actor_id, subject_id, resource_type, resource_id,
    result, reason_code, correlation_id, detail
  ) VALUES (
    p_audit_id, 'ownership.transferred', 'member', p_actor_id, p_target_id, 'member',
    p_target_id, 'success', 'OWNERSHIP_TRANSFERRED', p_correlation_id,
    jsonb_build_object(
      'previousTargetRole', target_role,
      'outgoingOwnerRole', 'admin',
      'revision', promoted
    )
  );
END $$;

-- One call per member carrying every assignment and revocation for that member,
-- not one call per room. room_assignment_privilege_session_revoke fires on every
-- insert, update and delete of a room_assignment row and revokes all of that
-- member's active sessions, so staffing someone across four rooms as four calls
-- signs them out four times. One transaction is one revocation.
--
-- The TARGET MEMBER ROW is the serialization point, taken before anything is
-- decided. Locking only each room_assignment row left two batches naming
-- different rooms with no common lock: both could commit, and each returned a
-- "complete resulting set" that omitted the other's rows, so the surface could
-- show access that was already stale. The same lock closes a second race -- a
-- concurrent disable or role change passing an unlocked eligibility check and
-- leaving assignments on a member who is no longer eligible for them.
--
-- Re-staffing INSERTS a new active row and never deletes the revoked one.
-- one_active_room_assignment (above) makes only the active pair unique, so
-- terminal history accumulates and remains reconstructable. enforce_state_transition
-- still permits only active -> revoked, so a revoked privilege is never resurrected
-- by an UPDATE either.
--
-- The whole batch is validated before anything is written, so a malformed entry
-- cannot leave a half-applied change or an audit row describing work that was
-- rolled back.
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
  entry jsonb;
  room_key text;
  role_name text;
  assign_rooms text[] := '{}';
  assign_roles text[] := '{}';
  revoke_rooms text[] := '{}';
  target_role text;
  target_state text;
  existing_role text;
  changed integer := 0;
  slot integer;
  resulting jsonb;
  resulting_count integer;
BEGIN
  PERFORM assert_organization_administrator(p_actor_id);
  IF p_assign IS NULL OR p_revoke IS NULL
     OR jsonb_typeof(p_assign) <> 'array' OR jsonb_typeof(p_revoke) <> 'array' THEN
    RAISE EXCEPTION 'assignment batch must be two arrays' USING ERRCODE = '22023';
  END IF;
  -- A bound on one call keeps both the work and the audit detail finite. An
  -- installation with more rooms than this staffs in more than one batch.
  IF jsonb_array_length(p_assign) + jsonb_array_length(p_revoke) > 100 THEN
    RAISE EXCEPTION 'assignment batch too large' USING ERRCODE = '22023';
  END IF;
  -- Self-administration would revoke the acting administrator's own sessions
  -- through room_assignment_privilege_session_revoke, ending the request's own
  -- authorization as a side effect the response does not report.
  IF p_member_id = p_actor_id THEN
    RAISE EXCEPTION 'self room assignment forbidden' USING ERRCODE = '42501';
  END IF;
  -- The lock, then the eligibility decision under it. Every batch for one member
  -- serializes here, and a concurrent set_member_state or set_member_global_role
  -- either completes before this read or waits behind it.
  SELECT global_role, state INTO target_role, target_state
  FROM member WHERE id = p_member_id FOR UPDATE;
  -- §4.2: Owners and Admins already hold Room Manager authority everywhere, and
  -- only Members receive explicit assignments. An assignment row for an
  -- administrator would claim to narrow authority it cannot narrow -- a
  -- 'contributor' row beside standing Manager rights. An absent member is refused
  -- identically so a denial cannot enumerate member ids.
  IF target_role IS NULL OR target_state <> 'active' OR target_role <> 'member' THEN
    RAISE EXCEPTION 'member not assignable' USING ERRCODE = '42501';
  END IF;

  FOR entry IN SELECT value FROM jsonb_array_elements(p_revoke) AS elements(value) LOOP
    IF jsonb_typeof(entry) <> 'string' OR (entry #>> '{}') !~ '^[A-Za-z0-9_-]{32}$' THEN
      RAISE EXCEPTION 'invalid revocation entry' USING ERRCODE = '22023';
    END IF;
    room_key := entry #>> '{}';
    IF room_key = ANY (revoke_rooms) THEN
      RAISE EXCEPTION 'duplicate room in revocation batch' USING ERRCODE = '22023';
    END IF;
    revoke_rooms := revoke_rooms || room_key;
  END LOOP;

  FOR entry IN SELECT value FROM jsonb_array_elements(p_assign) AS elements(value) LOOP
    IF jsonb_typeof(entry) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(entry)) <> 2 THEN
      RAISE EXCEPTION 'invalid assignment entry' USING ERRCODE = '22023';
    END IF;
    room_key := entry->>'roomId';
    role_name := entry->>'roomRole';
    IF room_key IS NULL OR room_key !~ '^[A-Za-z0-9_-]{32}$'
       OR role_name IS NULL OR role_name NOT IN ('manager', 'contributor') THEN
      RAISE EXCEPTION 'invalid assignment entry' USING ERRCODE = '22023';
    END IF;
    -- Two entries for one room, or one room both assigned and revoked, state two
    -- different intentions. Guessing which one wins is worse than refusing.
    IF room_key = ANY (assign_rooms) THEN
      RAISE EXCEPTION 'duplicate room in assignment batch' USING ERRCODE = '22023';
    END IF;
    IF room_key = ANY (revoke_rooms) THEN
      RAISE EXCEPTION 'room both assigned and revoked' USING ERRCODE = '22023';
    END IF;
    assign_rooms := assign_rooms || room_key;
    assign_roles := assign_roles || role_name;
  END LOOP;

  -- Every room in the batch, assigned or revoked, must exist. The revoke loop used
  -- to UPDATE without checking, so an unknown room id was indistinguishable from a
  -- valid unassigned one: changed=0, a success response, and a success audit row
  -- naming work that could not have happened. An unknown room and an unreachable
  -- one share the assignment path's denial, so neither can enumerate room ids.
  FOR slot IN 1..coalesce(array_length(revoke_rooms, 1), 0) LOOP
    IF NOT EXISTS (SELECT 1 FROM room WHERE id = revoke_rooms[slot]) THEN
      RAISE EXCEPTION 'room not found' USING ERRCODE = '42501';
    END IF;
  END LOOP;

  FOR slot IN 1..coalesce(array_length(assign_rooms, 1), 0) LOOP
    room_key := assign_rooms[slot];
    role_name := assign_roles[slot];
    -- An unknown room and a room the actor may not see share one refusal, so the
    -- response cannot be used to enumerate room ids.
    IF NOT EXISTS (SELECT 1 FROM room WHERE id = room_key) THEN
      RAISE EXCEPTION 'room not found' USING ERRCODE = '42501';
    END IF;
    SELECT room_role INTO existing_role
    FROM room_assignment
    WHERE room_id = room_key AND member_id = p_member_id AND state = 'active'
    FOR UPDATE;
    IF existing_role IS NULL THEN
      -- No active row, whether or not revoked rows exist. A new active assignment
      -- is inserted beside them; the revoked history is never deleted.
      INSERT INTO room_assignment (id, room_id, member_id, room_role)
      VALUES (replace(gen_random_uuid()::text, '-', ''), room_key, p_member_id, role_name);
      changed := changed + 1;
    ELSIF existing_role <> role_name THEN
      UPDATE room_assignment SET room_role = role_name
      WHERE room_id = room_key AND member_id = p_member_id AND state = 'active';
      changed := changed + 1;
    END IF;
  END LOOP;

  FOR slot IN 1..coalesce(array_length(revoke_rooms, 1), 0) LOOP
    UPDATE room_assignment SET state = 'revoked'
    WHERE member_id = p_member_id AND room_id = revoke_rooms[slot] AND state = 'active';
    IF FOUND THEN changed := changed + 1; END IF;
  END LOOP;

  -- The caller receives the member's complete resulting assignment set, not a
  -- count it would have to interpret. A surface that had to infer the outcome
  -- from a number could show access the server did not grant.
  --
  -- "Complete" is only an honest promise if it is also bounded, and rooms are a
  -- growing collection with no installation cap (§23). Rather than silently
  -- truncating the set the response claims is complete, one member's active
  -- assignment total is capped: a batch that would carry them past it is refused
  -- whole, and the transaction rolls back. 500 rooms for one person is already far
  -- beyond plausible internal staffing, so the bound refuses runaway growth without
  -- constraining real use. read_members carries the same number as its page budget,
  -- which is what lets it promise a COMPLETE set for every subject it returns.
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

-- Direct table authority that predates the audited boundaries above.
--
-- 001 granted duefold_runtime full DML on room_assignment and duefold_authenticator
-- full DML on room_assignment, invitation, and member. Those grants are why the
-- functions above could be bypassed entirely: the web credential could grant or
-- revoke a room privilege with no administrator check and no audit row, and the
-- authenticator credential could rewrite intended_global_role from 'member' to
-- 'admin' before acceptance, escalating an invitee without using the audited
-- invitation path. Either route defeats invariant 14, so the privileges are
-- narrowed here to exactly what each credential's remaining direct SQL needs.
--
-- 007 already revoked invitation from runtime and worker and re-granted the
-- authenticator SELECT and UPDATE(state). PostgreSQL grants are additive, so that
-- re-grant never removed 001's broader one; the broad grant is revoked first and
-- the narrow pair restated, which is the only order that actually narrows it.
REVOKE ALL ON invitation FROM duefold_runtime, duefold_authenticator, duefold_worker;
-- Acceptance reads the pending invitation and writes only its state
-- (modules/core-security/src/auth/oidc.ts). It has no reason to author an
-- invitation or to choose the role one carries.
GRANT SELECT ON invitation TO duefold_authenticator;
GRANT UPDATE (state) ON invitation TO duefold_authenticator;

-- Room privileges are now writable only through apply_room_assignments. Both
-- credentials keep SELECT because session authorization resolves a member's room
-- roles on every request (apps/web/src/authenticate.ts).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON room_assignment
  FROM duefold_runtime, duefold_authenticator, duefold_worker;
GRANT SELECT ON room_assignment TO duefold_runtime, duefold_authenticator;

-- member keeps its authenticator DML: first-owner bootstrap, OIDC acceptance, and
-- guarded CLI owner recovery all insert or update member rows on that credential
-- and each writes its audit row in the same transaction. The runtime credential
-- keeps SELECT only, as 001 left it, so role and state changes stay confined to
-- set_member_global_role, set_member_state, and transfer_ownership.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON member FROM duefold_runtime, duefold_worker;

REVOKE ALL ON FUNCTION assert_organization_administrator(text)
  FROM PUBLIC,duefold_runtime,duefold_worker,duefold_authenticator;
REVOKE ALL ON FUNCTION cancel_member_invitation_mail(text)
  FROM PUBLIC,duefold_runtime,duefold_worker,duefold_authenticator;
REVOKE ALL ON FUNCTION invite_member(text,text,text,text,text,text,text,text)
  FROM PUBLIC,duefold_runtime,duefold_worker,duefold_authenticator;
REVOKE ALL ON FUNCTION revoke_member_invitation(text,text,text,text)
  FROM PUBLIC,duefold_runtime,duefold_worker,duefold_authenticator;
REVOKE ALL ON FUNCTION read_members(text,timestamptz,text,integer)
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
REVOKE ALL ON FUNCTION apply_room_assignments(text,jsonb,jsonb,text,text,text)
  FROM PUBLIC,duefold_runtime,duefold_worker,duefold_authenticator;
REVOKE ALL ON FUNCTION member_assignment_impact(text)
  FROM PUBLIC,duefold_runtime,duefold_worker,duefold_authenticator;

GRANT EXECUTE ON FUNCTION invite_member(text,text,text,text,text,text,text,text)
  TO duefold_runtime;
GRANT EXECUTE ON FUNCTION revoke_member_invitation(text,text,text,text)
  TO duefold_runtime;
GRANT EXECUTE ON FUNCTION read_members(text,timestamptz,text,integer)
  TO duefold_runtime;
GRANT EXECUTE ON FUNCTION read_member_invitation_mail(text,text,text,text)
  TO duefold_worker;
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

ALTER FUNCTION assert_organization_administrator(text) OWNER TO duefold_migration;
ALTER FUNCTION cancel_member_invitation_mail(text) OWNER TO duefold_migration;
ALTER FUNCTION invite_member(text,text,text,text,text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION revoke_member_invitation(text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION read_members(text,timestamptz,text,integer) OWNER TO duefold_migration;
ALTER FUNCTION read_member_invitation_mail(text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION set_member_global_role(text,text,text,integer,text,text) OWNER TO duefold_migration;
ALTER FUNCTION set_member_state(text,text,text,integer,text,text) OWNER TO duefold_migration;
ALTER FUNCTION dry_run_ownership_transfer(text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION transfer_ownership(text,text,integer,timestamptz,text,text,text,text)
  OWNER TO duefold_migration;
ALTER FUNCTION apply_room_assignments(text,jsonb,jsonb,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION member_assignment_impact(text) OWNER TO duefold_migration;
REVOKE ALL ON FUNCTION supersede_room_assignments_for_role(text,text,text,text)
  FROM PUBLIC,duefold_runtime,duefold_worker,duefold_authenticator;
ALTER FUNCTION supersede_room_assignments_for_role(text,text,text,text)
  OWNER TO duefold_migration;
ALTER TABLE ownership_transfer_preview OWNER TO duefold_migration;
REVOKE ALL ON ownership_transfer_preview
  FROM PUBLIC,duefold_runtime,duefold_worker,duefold_authenticator;
