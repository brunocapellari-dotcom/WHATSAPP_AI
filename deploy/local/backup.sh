#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

[[ -f .env ]] || { echo "LOCAL_BACKUP_FAIL: run ./setup.sh first" >&2; exit 2; }

mkdir -p backups
chmod 700 backups

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="backups/whatsapp_ai_${stamp}.dump"

docker compose --env-file .env exec -T postgres   pg_dump -U postgres -d whatsapp_ai -Fc >"$target"

[[ -s "$target" ]] || { rm -f "$target"; echo "LOCAL_BACKUP_FAIL: empty dump" >&2; exit 3; }
chmod 600 "$target"

sha256sum "$target" >"${target}.sha256"
chmod 600 "${target}.sha256"

find backups -type f -name 'whatsapp_ai_*.dump' -mtime +14 -delete
find backups -type f -name 'whatsapp_ai_*.dump.sha256' -mtime +14 -delete

echo "LOCAL_BACKUP_PASS file=$target"
