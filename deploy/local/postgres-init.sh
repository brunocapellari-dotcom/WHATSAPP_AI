#!/usr/bin/env bash
set -euo pipefail

: "${DB_INGEST_USER:?DB_INGEST_USER is required}"
: "${DB_INGEST_PASSWORD:?DB_INGEST_PASSWORD is required}"
: "${DB_WORKER_USER:?DB_WORKER_USER is required}"
: "${DB_WORKER_PASSWORD:?DB_WORKER_PASSWORD is required}"
: "${DB_REPORT_USER:?DB_REPORT_USER is required}"
: "${DB_REPORT_PASSWORD:?DB_REPORT_PASSWORD is required}"

psql -v ON_ERROR_STOP=1   --username "$POSTGRES_USER"   --dbname "$POSTGRES_DB"   --set=ingest_user="$DB_INGEST_USER"   --set=ingest_password="$DB_INGEST_PASSWORD"   --set=worker_user="$DB_WORKER_USER"   --set=worker_password="$DB_WORKER_PASSWORD"   --set=report_user="$DB_REPORT_USER"   --set=report_password="$DB_REPORT_PASSWORD" <<'SQL'
SELECT format(
    'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
    :'ingest_user',
    :'ingest_password'
)
WHERE NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = :'ingest_user'
)
\gexec

SELECT format(
    'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
    :'worker_user',
    :'worker_password'
)
WHERE NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = :'worker_user'
)
\gexec

SELECT format(
    'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
    :'report_user',
    :'report_password'
)
WHERE NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = :'report_user'
)
\gexec
SQL
