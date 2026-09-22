#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FINAL="$BACKUP_DIR/whatsapp_ai-$STAMP.dump"
TMP="$FINAL.tmp"

cleanup() {
  rm -f "$TMP"
}
trap cleanup EXIT

docker compose exec -T postgres   pg_dump     --username=whatsapp_ai     --dbname=whatsapp_ai     --format=custom     --no-owner     --no-privileges   > "$TMP"

test -s "$TMP"
chmod 600 "$TMP"
mv "$TMP" "$FINAL"
sha256sum "$FINAL" > "$FINAL.sha256"
chmod 600 "$FINAL.sha256"

echo "$FINAL"
