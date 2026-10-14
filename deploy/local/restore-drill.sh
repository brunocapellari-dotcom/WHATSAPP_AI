#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

[[ -f .env ]] || { echo "LOCAL_RESTORE_FAIL: run ./setup.sh first" >&2; exit 2; }

backup="${1:-}"
if [[ -z "$backup" ]]; then
  backup="$(ls -1t backups/whatsapp_ai_*.dump 2>/dev/null | head -n1 || true)"
fi
[[ -n "$backup" && -f "$backup" ]] || { echo "LOCAL_RESTORE_FAIL: backup not found" >&2; exit 2; }

[[ -f "${backup}.sha256" ]] || {
  echo "LOCAL_RESTORE_FAIL: missing ${backup}.sha256; refusing an unverified backup" >&2
  exit 2
}
sha256sum -c "${backup}.sha256" >/dev/null || {
  echo "LOCAL_RESTORE_FAIL: backup checksum mismatch" >&2
  exit 3
}

drill_db="whatsapp_ai_restore_$(date -u +%Y%m%d%H%M%S)"
cleanup() {
  docker compose --env-file .env exec -T postgres \
    psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS \"$drill_db\" WITH (FORCE);" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker compose --env-file .env exec -T postgres \
  createdb -U postgres "$drill_db"

cat "$backup" | docker compose --env-file .env exec -T postgres \
  pg_restore -U postgres -d "$drill_db" --no-owner --no-privileges

tables="$(docker compose --env-file .env exec -T postgres \
  psql -U postgres -d "$drill_db" -Atc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('whatsapp_raw_events','whatsapp_freight_events','whatsapp_freight_event_versions','whatsapp_processed_source_events','whatsapp_agrolog_outbox','whatsapp_schema_migrations');")"

[[ "$tables" == "6" ]] || {
  echo "LOCAL_RESTORE_FAIL: expected 6 critical tables, got $tables" >&2
  exit 3
}

drill_sql() {
  docker compose --env-file .env exec -T postgres \
    psql -U postgres -d "$drill_db" -v ON_ERROR_STOP=1 -Atc "$1"
}

# Same invariants as scripts/validate_restored_database.py (cloud profile):
# migration ledger must match the repository migrations byte-for-byte, and RLS
# must remain enabled+forced on every tenant table after restore.
expected_migrations="$(cd ../../migrations && for f in *.sql; do
  printf '%s|%s\n' "$f" "$(sha256sum "$f" | cut -d' ' -f1)"
done | LC_ALL=C sort)"
restored_migrations="$(drill_sql "SELECT version || '|' || checksum FROM whatsapp_schema_migrations" | LC_ALL=C sort)"
[[ "$restored_migrations" == "$expected_migrations" ]] || {
  echo "LOCAL_RESTORE_FAIL: restored migration ledger does not match repository migrations" >&2
  exit 4
}

rls_forced="$(drill_sql "SELECT count(*) FROM pg_class WHERE relname IN ('whatsapp_raw_events','whatsapp_freight_events','whatsapp_freight_event_versions','whatsapp_processed_source_events','whatsapp_agrolog_outbox') AND relrowsecurity AND relforcerowsecurity;")"
[[ "$rls_forced" == "5" ]] || {
  echo "LOCAL_RESTORE_FAIL: RLS not enabled+forced on all 5 tenant tables (got $rls_forced)" >&2
  exit 5
}

counts="$(drill_sql "SELECT 'raw=' || (SELECT count(*) FROM whatsapp_raw_events) || ' events=' || (SELECT count(*) FROM whatsapp_freight_events) || ' versions=' || (SELECT count(*) FROM whatsapp_freight_event_versions) || ' outbox=' || (SELECT count(*) FROM whatsapp_agrolog_outbox);")"
backup_sha256="$(sha256sum "$backup" | cut -d' ' -f1)"
migration_count="$(printf '%s\n' "$expected_migrations" | wc -l | tr -d ' ')"

echo "LOCAL_RESTORE_DRILL_PASS backup=$backup sha256=$backup_sha256 database=$drill_db migrations=$migration_count rls_forced_tables=$rls_forced $counts"
