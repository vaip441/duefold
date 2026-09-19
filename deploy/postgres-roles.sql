-- Duefold database roles.
--
-- Creates the four login roles and nothing else. The TABLE and FUNCTION privileges
-- are owned by the migrations, which GRANT and REVOKE them as the schema evolves.
--
-- This file deliberately does NOT restate those privileges. A second list would be a
-- second source of truth, and the one nobody reads becomes wrong: several waves have
-- revoked a grant (the runtime role's read on document_version, its DML on member and
-- viewer) precisely because it was too wide, and a bootstrap script that re-granted
-- them at deploy time would silently undo that. The privilege matrix in
-- test/authz/participant-grants.test.ts asserts the resulting state, so drift here is
-- caught by a failing test rather than by an incident.
--
-- Why four roles rather than one. The split is the boundary that stops a web-process
-- compromise from becoming a viewer-session forgery:
--
--   duefold_migration      owns the schema; DDL only, never used at runtime
--   duefold_runtime        the web request path; no read of document_version or
--                          document_derivative, no session mutation
--   duefold_authenticator  session, otp_challenge, oidc_transaction, and identity;
--                          no EXECUTE on any delivery, lease, or grant function
--   duefold_worker         processing; reads content rows, holds no session access
--
-- The web process compares current_user across its two pools at startup and refuses
-- to boot if they match, so collapsing the runtime and authenticator roles into one
-- connection string fails loudly instead of quietly re-enabling forgery.
--
-- Passwords are read from the environment. The :'name' placeholders are psql
-- variables, so this runs as:
--   psql -v migration_password="$..." -v runtime_password="$..." ... -f postgres-roles.sql
-- An unset variable makes psql fail rather than create a role with a literal
-- placeholder as its password.

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF current_setting('server_version_num')::int < 180000 THEN
    -- Migrations use PostgreSQL 18 behaviour; an older server would apply them
    -- differently rather than failing cleanly.
    RAISE EXCEPTION 'Duefold requires PostgreSQL 18 or newer, found %',
      current_setting('server_version');
  END IF;
END
$$;

CREATE ROLE duefold_migration LOGIN PASSWORD :'migration_password';
CREATE ROLE duefold_runtime LOGIN PASSWORD :'runtime_password';
CREATE ROLE duefold_authenticator LOGIN PASSWORD :'authenticator_password';
CREATE ROLE duefold_worker LOGIN PASSWORD :'worker_password';

GRANT CONNECT ON DATABASE duefold TO
  duefold_migration, duefold_runtime, duefold_authenticator, duefold_worker;

-- The migration role owns every object, so later migrations can ALTER them without
-- superuser and without SET ROLE.
ALTER DATABASE duefold OWNER TO duefold_migration;
GRANT ALL ON SCHEMA public TO duefold_migration;
GRANT USAGE ON SCHEMA public TO
  duefold_runtime, duefold_authenticator, duefold_worker;

-- No role may create objects in the schema at runtime. A definer function is the only
-- way privileged work happens, and CREATE would let a compromised role install one.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE duefold FROM PUBLIC;
