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

if [[ -f "${backup}.sha256" ]]; then
  sha256sum -c "${backup}.sha256" >/dev/null
fi

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
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('whatsapp_raw_events','whatsapp_freight_events','whatsapp_processed_source_events','whatsapp_agrolog_outbox','whatsapp_schema_migrations');")"

[[ "$tables" == "5" ]] || {
  echo "LOCAL_RESTORE_FAIL: expected 5 critical tables, got $tables" >&2
  exit 3
}

echo "LOCAL_RESTORE_DRILL_PASS backup=$backup database=$drill_db"
