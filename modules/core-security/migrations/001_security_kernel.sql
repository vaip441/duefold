-- Duefold security kernel. This migration is immutable after application.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'duefold_migration') THEN
    CREATE ROLE duefold_migration LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'duefold_runtime') THEN
    CREATE ROLE duefold_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'duefold_worker') THEN
    CREATE ROLE duefold_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'duefold_authenticator') THEN
    CREATE ROLE duefold_authenticator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;

CREATE FUNCTION canonical_email_key(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT value = normalize(lower(btrim(value)), NFC)
    AND length(value) BETWEEN 3 AND 320
    AND value ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
$$;

CREATE TABLE organization (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  id text NOT NULL UNIQUE CHECK (id ~ '^[A-Za-z0-9_-]{32}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE member (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{32}$'),
  email_key text NOT NULL UNIQUE CHECK (canonical_email_key(email_key)),
  email_display text NOT NULL CHECK (length(email_display) BETWEEN 3 AND 320),
  oidc_issuer text NOT NULL,
  oidc_subject text NOT NULL,
  global_role text NOT NULL CHECK (global_role IN ('owner', 'admin', 'member')),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('invited', 'active', 'disabled')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (oidc_issuer, oidc_subject)
);
CREATE UNIQUE INDEX one_active_owner ON member ((global_role))
  WHERE global_role = 'owner' AND state = 'active';

CREATE TABLE viewer (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{32}$'),
  email_key text NOT NULL UNIQUE CHECK (canonical_email_key(email_key)),
  email_display text NOT NULL CHECK (length(email_display) BETWEEN 3 AND 320),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked', 'anonymized')),
  session_family_id text NOT NULL CHECK (session_family_id ~ '^[A-Za-z0-9_-]{32}$'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE invitation (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{32}$'),
  kind text NOT NULL CHECK (kind IN ('member', 'viewer')),
  email_key text NOT NULL CHECK (canonical_email_key(email_key)),
  email_display text NOT NULL CHECK (length(email_display) BETWEEN 3 AND 320),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'accepted', 'revoked', 'expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK (expires_at > created_at),
  UNIQUE (kind, email_key, state)
);

CREATE TABLE oidc_transaction (
  state_digest char(64) PRIMARY KEY,
  nonce text NOT NULL CHECK (length(nonce) BETWEEN 32 AND 200),
  code_verifier text NOT NULL CHECK (length(code_verifier) BETWEEN 43 AND 128),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK (expires_at > created_at)
);

CREATE TABLE otp_challenge (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{32}$'),
  email_key text NOT NULL CHECK (canonical_email_key(email_key)),
  viewer_id text REFERENCES viewer(id),
  digest text CHECK (digest IS NULL OR length(digest) = 64),
  state text NOT NULL DEFAULT 'awaiting_delivery' CHECK (state IN ('awaiting_delivery', 'pending', 'consumed', 'invalidated', 'expired', 'locked')),
  failed_attempts smallint NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  network_period char(7) NOT NULL CHECK (network_period ~ '^[0-9]{4}-[0-9]{2}$'),
  network_hmac text NOT NULL CHECK (length(network_hmac) = 64),
  browser_category text NOT NULL CHECK (browser_category IN ('chromium', 'firefox', 'safari', 'other')),
  os_category text NOT NULL CHECK (os_category IN ('windows', 'macos', 'linux', 'ios', 'android', 'other')),
  device_category text NOT NULL CHECK (device_category IN ('desktop', 'mobile', 'tablet', 'other')),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK ((state = 'awaiting_delivery' AND digest IS NULL AND expires_at IS NULL) OR
         (state = 'invalidated' AND ((digest IS NULL AND expires_at IS NULL) OR
           (digest IS NOT NULL AND expires_at IS NOT NULL AND expires_at > created_at))) OR
         (state IN ('pending', 'consumed', 'expired', 'locked') AND
           digest IS NOT NULL AND expires_at IS NOT NULL AND expires_at > created_at))
);
CREATE UNIQUE INDEX one_pending_otp_per_email ON otp_challenge (email_key)
  WHERE state IN ('awaiting_delivery', 'pending');
CREATE INDEX otp_abuse_email_window ON otp_challenge (email_key, created_at);
CREATE INDEX otp_abuse_network_window ON otp_challenge (network_period, network_hmac, created_at);
CREATE INDEX otp_abuse_installation_window ON otp_challenge (created_at);

CREATE TABLE session (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{32}$'),
  secret_digest text NOT NULL UNIQUE CHECK (length(secret_digest) = 64),
  csrf_digest text NOT NULL CHECK (length(csrf_digest) = 64),
  principal_kind text NOT NULL CHECK (principal_kind IN ('member', 'viewer')),
  member_id text REFERENCES member(id),
  viewer_id text REFERENCES viewer(id),
  family_id text NOT NULL CHECK (family_id ~ '^[A-Za-z0-9_-]{32}$'),
  oidc_authenticated_at timestamptz,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'rotated', 'revoked', 'expired')),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK ((principal_kind = 'member' AND member_id IS NOT NULL AND viewer_id IS NULL) OR
         (principal_kind = 'viewer' AND viewer_id IS NOT NULL AND member_id IS NULL)),
  CHECK (idle_expires_at <= absolute_expires_at),
  CHECK (absolute_expires_at > created_at)
);
CREATE INDEX active_session_family ON session (family_id) WHERE state = 'active';

-- room_id initially has no FK. The rooms-documents migration adds
-- the FK after creating room, avoiding an illicit dormant room table here.
CREATE TABLE room_assignment (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{32}$'),
  room_id text NOT NULL CHECK (room_id ~ '^[A-Za-z0-9_-]{32}$'),
  member_id text NOT NULL REFERENCES member(id),
  room_role text NOT NULL CHECK (room_role IN ('manager', 'contributor')),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (room_id, member_id)
);
COMMENT ON COLUMN room_assignment.room_id IS 'FK to room(id) is added by the rooms-documents migration.';

CREATE TABLE audit_event (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id text NOT NULL UNIQUE CHECK (id ~ '^[A-Za-z0-9_-]{32}$'),
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.]{2,99}$'),
  occurred_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  actor_kind text NOT NULL CHECK (actor_kind IN ('member', 'viewer', 'system', 'operator')),
  actor_id text,
  subject_id text,
  room_id text,
  resource_type text,
  resource_id text,
  result text NOT NULL CHECK (result IN ('success', 'denied', 'failure')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  correlation_id text NOT NULL CHECK (correlation_id ~ '^corr_[A-Za-z0-9_-]{32}$'),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object')
);

CREATE FUNCTION reject_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'audit_event is append-only' USING ERRCODE = '55000';
END $$;
CREATE TRIGGER audit_event_append_only BEFORE UPDATE OR DELETE ON audit_event
FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

CREATE TABLE mutation_key (
  key text PRIMARY KEY CHECK (length(key) BETWEEN 16 AND 200),
  operation text NOT NULL CHECK (length(operation) BETWEEN 3 AND 100),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE job_queue (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{32}$'),
  job_type text NOT NULL CHECK (job_type ~ '^[a-z][a-z0-9_.]{2,99}$'),
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 16 AND 200),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'succeeded', 'failed')),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  max_attempts smallint NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  available_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  lease_owner text,
  lease_token text,
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK ((state = 'running' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR
         (state <> 'running' AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL))
);
CREATE INDEX available_jobs ON job_queue (available_at, created_at)
  WHERE state = 'pending' OR state = 'running';

CREATE FUNCTION enqueue_job(
  p_id text, p_job_type text, p_idempotency_key text, p_payload jsonb,
  p_available_at timestamptz DEFAULT transaction_timestamp(), p_max_attempts integer DEFAULT 5
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN
  /*
   * A generic enqueue boundary is a privilege-escalation path: the web role can
   * read object keys, so an unrestricted job type let it manufacture
   * worker-internal work (notably derivative cleanup) and delete arbitrary
   * derivative objects. Only job types a request path legitimately originates
   * are accepted here; worker-internal jobs must be enqueued by the worker,
   * which holds direct job_queue authority.
   */
  IF p_job_type NOT IN ('auth.otp.deliver', 'upload.multipart.reap', 'document.source.validate') THEN
    RAISE EXCEPTION 'job type not enqueueable by this role' USING ERRCODE = '42501';
  END IF;
  INSERT INTO job_queue (id,job_type,idempotency_key,payload,available_at,max_attempts)
  VALUES (p_id,p_job_type,p_idempotency_key,p_payload,p_available_at,p_max_attempts);
END $$;
COMMENT ON FUNCTION enqueue_job(text,text,text,jsonb,timestamptz,integer) IS
  'Pending-only web enqueue boundary restricted to request-originated job types; callers cannot supply state, attempts, or lease evidence.';

CREATE FUNCTION enforce_exactly_one_owner() RETURNS trigger
LANGUAGE plpgsql AS $$ DECLARE owner_count integer; org_count integer; BEGIN
  SELECT count(*) INTO org_count FROM organization;
  SELECT count(*) INTO owner_count FROM member WHERE global_role = 'owner' AND state = 'active';
  IF NOT ((org_count = 0 AND owner_count = 0) OR (org_count = 1 AND owner_count = 1)) THEN
    RAISE EXCEPTION 'installation must have one organization and exactly one active Owner' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER exactly_one_owner_after_member
AFTER INSERT OR UPDATE OR DELETE ON member DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_exactly_one_owner();
CREATE CONSTRAINT TRIGGER exactly_one_owner_after_organization
AFTER INSERT OR UPDATE OR DELETE ON organization DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_exactly_one_owner();
CREATE FUNCTION reject_organization_delete() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'organization deletion is unsupported' USING ERRCODE = '55000';
END $$;
CREATE TRIGGER organization_no_delete BEFORE DELETE ON organization
FOR EACH ROW EXECUTE FUNCTION reject_organization_delete();

CREATE FUNCTION enforce_state_transition() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF TG_TABLE_NAME = 'member' AND NOT (
    OLD.state = NEW.state OR
    (OLD.state = 'invited' AND NEW.state IN ('active', 'disabled')) OR
    (OLD.state = 'active' AND NEW.state = 'disabled') OR
    (OLD.state = 'disabled' AND NEW.state = 'active')) THEN
    RAISE EXCEPTION 'invalid member state transition' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'viewer' AND NOT (
    OLD.state = NEW.state OR (OLD.state = 'active' AND NEW.state IN ('revoked', 'anonymized')) OR
    (OLD.state = 'revoked' AND NEW.state = 'anonymized')) THEN
    RAISE EXCEPTION 'invalid viewer state transition' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'invitation' AND NOT (
    OLD.state = NEW.state OR (OLD.state = 'pending' AND NEW.state IN ('accepted', 'revoked', 'expired'))) THEN
    RAISE EXCEPTION 'invalid invitation state transition' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'session' AND NOT (
    OLD.state = NEW.state OR (OLD.state = 'active' AND NEW.state IN ('rotated', 'revoked', 'expired'))) THEN
    RAISE EXCEPTION 'invalid session state transition' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'otp_challenge' AND NOT (
    OLD.state = NEW.state OR
    (OLD.state = 'awaiting_delivery' AND NEW.state IN ('pending', 'invalidated')) OR
    (OLD.state = 'pending' AND NEW.state IN ('consumed', 'invalidated', 'expired', 'locked'))) THEN
    RAISE EXCEPTION 'invalid OTP state transition' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'room_assignment' AND NOT (
    OLD.state = NEW.state OR (OLD.state = 'active' AND NEW.state = 'revoked')) THEN
    RAISE EXCEPTION 'invalid room assignment state transition' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'job_queue' AND NOT (
    OLD.state = NEW.state OR
    (OLD.state = 'pending' AND NEW.state = 'running') OR
    (OLD.state = 'running' AND NEW.state IN ('pending', 'succeeded', 'failed'))) THEN
    RAISE EXCEPTION 'invalid job state transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER member_state_transition BEFORE UPDATE OF state ON member FOR EACH ROW EXECUTE FUNCTION enforce_state_transition();
CREATE TRIGGER viewer_state_transition BEFORE UPDATE OF state ON viewer FOR EACH ROW EXECUTE FUNCTION enforce_state_transition();
CREATE TRIGGER invitation_state_transition BEFORE UPDATE OF state ON invitation FOR EACH ROW EXECUTE FUNCTION enforce_state_transition();
CREATE TRIGGER session_state_transition BEFORE UPDATE OF state ON session FOR EACH ROW EXECUTE FUNCTION enforce_state_transition();
CREATE TRIGGER otp_state_transition BEFORE UPDATE OF state ON otp_challenge FOR EACH ROW EXECUTE FUNCTION enforce_state_transition();
CREATE TRIGGER room_assignment_state_transition BEFORE UPDATE OF state ON room_assignment FOR EACH ROW EXECUTE FUNCTION enforce_state_transition();
CREATE TRIGGER job_queue_state_transition BEFORE UPDATE OF state ON job_queue FOR EACH ROW EXECUTE FUNCTION enforce_state_transition();

-- Direct privilege changes cannot leave a previously-authorized session active.
CREATE FUNCTION revoke_sessions_for_privilege_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN
  IF TG_TABLE_NAME = 'member' THEN
    UPDATE session SET state = 'revoked'
      WHERE member_id = NEW.id AND state = 'active'
        AND (OLD.global_role IS DISTINCT FROM NEW.global_role OR OLD.state IS DISTINCT FROM NEW.state);
  ELSE
    UPDATE session SET state = 'revoked'
      WHERE member_id = COALESCE(NEW.member_id, OLD.member_id) AND state = 'active';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER member_privilege_session_revoke
AFTER UPDATE OF global_role, state ON member FOR EACH ROW EXECUTE FUNCTION revoke_sessions_for_privilege_change();
CREATE TRIGGER room_assignment_privilege_session_revoke
AFTER INSERT OR UPDATE OR DELETE ON room_assignment FOR EACH ROW EXECUTE FUNCTION revoke_sessions_for_privilege_change();

GRANT USAGE ON SCHEMA public TO duefold_runtime, duefold_worker, duefold_authenticator;
GRANT SELECT, INSERT, UPDATE ON organization TO duefold_runtime, duefold_authenticator;
REVOKE DELETE, TRUNCATE ON organization FROM duefold_runtime, duefold_authenticator;
/* The web runtime reads principals to authorize requests, but it must not be
 * able to mutate identity or role without an audited SECURITY DEFINER path.
 * Direct DML here let the shared web credential change a viewer's or member's
 * state, or escalate a global role, with no audit row in the same transaction --
 * breaking the transactional audit invariant. Member and viewer provisioning is
 * authentication work and runs on the authenticator pool. `invitation` keeps
 * only narrow consumption privileges; `room_assignment`
 * and `mutation_key` are request-scoped authorization and idempotency data, not
 * identity. */
GRANT SELECT ON member, viewer TO duefold_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON room_assignment, mutation_key TO duefold_runtime;
GRANT SELECT ON invitation TO duefold_runtime;
GRANT UPDATE (state) ON invitation TO duefold_runtime;
/* mutation_key is a request idempotency fence, not authentication evidence; it
 * remains runtime-owned. invitation is created only through audited participant
 * functions and is later narrowed to authenticator-only SELECT/UPDATE(state).
 * Authentication evidence and session lifecycle belong to a credential that
 * cannot reach protected content. The shared web runtime must never be able to
 * mint a principal and then consume that assertion at a delivery boundary. */
REVOKE ALL ON session, otp_challenge, oidc_transaction FROM duefold_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON member, viewer, session, otp_challenge,
  invitation, oidc_transaction, room_assignment TO duefold_authenticator;
GRANT SELECT ON job_queue TO duefold_runtime;
GRANT SELECT ON viewer TO duefold_worker;
GRANT SELECT, UPDATE ON otp_challenge TO duefold_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON job_queue TO duefold_worker;
REVOKE ALL ON FUNCTION enqueue_job(text,text,text,jsonb,timestamptz,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enqueue_job(text,text,text,jsonb,timestamptz,integer) TO duefold_runtime, duefold_worker, duefold_authenticator;
GRANT SELECT, INSERT ON audit_event TO duefold_runtime, duefold_worker, duefold_authenticator;
GRANT USAGE, SELECT ON SEQUENCE audit_event_sequence_seq TO duefold_runtime, duefold_worker, duefold_authenticator;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_event FROM duefold_runtime, duefold_worker, duefold_authenticator;
REVOKE CREATE ON SCHEMA public FROM duefold_runtime, duefold_worker, duefold_authenticator;

-- Existing objects are explicitly owned by the migration login so every later
-- migration can ALTER them without superuser or SET ROLE.
ALTER FUNCTION canonical_email_key(text) OWNER TO duefold_migration;
ALTER FUNCTION reject_audit_mutation() OWNER TO duefold_migration;
ALTER FUNCTION enforce_exactly_one_owner() OWNER TO duefold_migration;
ALTER FUNCTION reject_organization_delete() OWNER TO duefold_migration;
ALTER FUNCTION enforce_state_transition() OWNER TO duefold_migration;
ALTER FUNCTION revoke_sessions_for_privilege_change() OWNER TO duefold_migration;
ALTER FUNCTION enqueue_job(text,text,text,jsonb,timestamptz,integer) OWNER TO duefold_migration;
ALTER SEQUENCE audit_event_sequence_seq OWNER TO duefold_migration;
ALTER TABLE organization OWNER TO duefold_migration;
ALTER TABLE member OWNER TO duefold_migration;
ALTER TABLE viewer OWNER TO duefold_migration;
ALTER TABLE invitation OWNER TO duefold_migration;
ALTER TABLE oidc_transaction OWNER TO duefold_migration;
ALTER TABLE otp_challenge OWNER TO duefold_migration;
ALTER TABLE session OWNER TO duefold_migration;
ALTER TABLE room_assignment OWNER TO duefold_migration;
ALTER TABLE audit_event OWNER TO duefold_migration;
ALTER TABLE mutation_key OWNER TO duefold_migration;
ALTER TABLE job_queue OWNER TO duefold_migration;
GRANT USAGE, CREATE ON SCHEMA public TO duefold_migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO duefold_migration;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO duefold_migration;
