#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
DUMP="${1:-}"

if [[ -z "$DUMP" ]]; then
  DUMP="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'whatsapp_ai-*.dump' -print | sort | tail -n 1)"
fi

if [[ -z "$DUMP" || ! -f "$DUMP" ]]; then
  echo "No backup dump found." >&2
  exit 1
fi

if [[ -f "$DUMP.sha256" ]]; then
  (cd "$(dirname "$DUMP")" && sha256sum --check "$(basename "$DUMP").sha256")
fi

DB="whatsapp_ai_restore_$(date -u +%Y%m%d%H%M%S)_$$"
DB="${DB//[^a-zA-Z0-9_]/_}"

cleanup() {
  docker compose exec -T postgres     dropdb --username=whatsapp_ai --if-exists "$DB" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker compose exec -T postgres   createdb --username=whatsapp_ai "$DB"

cat "$DUMP" | docker compose exec -T postgres   pg_restore     --username=whatsapp_ai     --dbname="$DB"     --no-owner     --no-privileges     --exit-on-error

docker compose exec -T postgres   psql     --username=whatsapp_ai     --dbname="$DB"     --set=ON_ERROR_STOP=1     --tuples-only     --command="
      SELECT CASE WHEN to_regclass('public.schema_migrations') IS NOT NULL THEN 1 ELSE 0 END;
      SELECT CASE WHEN to_regclass('public.raw_messages') IS NOT NULL THEN 1 ELSE 0 END;
      SELECT CASE WHEN to_regclass('public.freight_events') IS NOT NULL THEN 1 ELSE 0 END;
      SELECT CASE WHEN to_regclass('public.business_message_runs') IS NOT NULL THEN 1 ELSE 0 END;
      SELECT CASE WHEN to_regclass('public.webhook_inbox') IS NOT NULL THEN 1 ELSE 0 END;
    " | awk 'NF { if ($1 != 1) exit 1 }'

echo "Restore rehearsal PASS: $DUMP"
