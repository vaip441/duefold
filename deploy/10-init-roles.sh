#!/bin/sh
set -eu

psql -v ON_ERROR_STOP=1 \
  -v migration_password="${DUEFOLD_DB_MIGRATION_PASSWORD:?missing migration password}" \
  -v runtime_password="${DUEFOLD_DB_RUNTIME_PASSWORD:?missing runtime password}" \
  -v authenticator_password="${DUEFOLD_DB_AUTHENTICATOR_PASSWORD:?missing authenticator password}" \
  -v worker_password="${DUEFOLD_DB_WORKER_PASSWORD:?missing worker password}" \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -f /usr/local/share/duefold/postgres-roles.sql
