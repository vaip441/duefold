#!/usr/bin/env bash
# Prepares PostgreSQL 18 on a GitHub-hosted Ubuntu runner for the integration, authz,
# and browser suites.
#
# The harnesses reset the test schema over the local socket at the default port as
# the operating-system user, so that user becomes a superuser here. The four
# application roles use the local-only throwaway passwords from .env.example and are
# NOINHERIT, matching the roles migration 001 would create.
set -euo pipefail

# The runner image ships an older cluster on 5432. The migrations require 18, and the
# harness connects to the default port, so the old cluster is removed first.
pg_lsclusters --no-header | while read -r version cluster _; do
  sudo pg_dropcluster --stop "$version" "$cluster"
done

sudo apt-get install -y --no-install-recommends postgresql-common
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
sudo apt-get install -y --no-install-recommends postgresql-18
sudo systemctl start postgresql@18-main
pg_isready --host /var/run/postgresql --port 5432 --timeout 30

sudo -u postgres createuser --superuser "$USER"
psql --dbname postgres --set ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE duefold_migration LOGIN NOINHERIT PASSWORD 'duefold_local_migration';
CREATE ROLE duefold_runtime LOGIN NOINHERIT PASSWORD 'duefold_local_runtime';
CREATE ROLE duefold_authenticator LOGIN NOINHERIT PASSWORD 'duefold_local_authenticator';
CREATE ROLE duefold_worker LOGIN NOINHERIT PASSWORD 'duefold_local_worker';
CREATE DATABASE duefold_test;
ALTER DATABASE duefold_test OWNER TO duefold_migration;
GRANT ALL ON SCHEMA public TO duefold_migration;
SQL
