#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "required command missing: $1" >&2
    exit 1
  }
}

require node
require npm
require docker
require git

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  echo "Node 22+ is required; found $(node --version)" >&2
  exit 1
fi

if [[ ! -f package-lock.json ]]; then
  echo "package-lock.json missing. Run scripts/prepare-lockfile.sh and commit it first." >&2
  exit 1
fi

echo "== direct dependency provenance =="
REMOTE_DEPENDENCIES="$(node --input-type=module -e '
  import fs from "node:fs";
  const pkg = JSON.parse(fs.readFileSync("package.json","utf8"));
  const deps = {...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {})};
  for (const [name, spec] of Object.entries(deps)) {
    if (/^https?:\/\//i.test(String(spec))) console.log(name + "=" + spec);
  }
')"
if [[ -n "$REMOTE_DEPENDENCIES" ]]; then
  echo "Release blocked: direct HTTP dependencies must be vendored and committed:" >&2
  echo "$REMOTE_DEPENDENCIES" >&2
  exit 1
fi

if ! git diff --quiet -- package.json package-lock.json; then
  echo "package manifest/lockfile has uncommitted changes." >&2
  exit 1
fi

RELEASE_TMP="$ROOT/.tmp/release-gate"
mkdir -p "$RELEASE_TMP"
export POSTGRES_PASSWORD="release_gate_postgres_password"
export WPP_API_TOKEN="release-gate-wpp-secret-0123456789"
export APP_ENV_FILE="$RELEASE_TMP/app.env"

cat > "$APP_ENV_FILE" <<EOF
NODE_ENV=test
ZERO_COST_MODE=true
DATABASE_URL=postgres://whatsapp_ai:$POSTGRES_PASSWORD@postgres:5432/whatsapp_ai
APP_ENCRYPTION_KEY=01234567890123456789012345678901
PII_HMAC_KEY=01234567890123456789012345678901
INTERNAL_API_KEY=test-internal-api-key-123456
LOCAL_AI_BASE_URL=http://ollama:11434
WHISPER_BASE_URL=http://whisper:8080
WPP_BASE_URL=http://wppconnect:21465
WPP_API_TOKEN=$WPP_API_TOKEN
WPP_COLLECTOR_ID=wpp-freight-default
AGROLOG_EXPORT_DIR=/data/agrolog-export
CLAMAV_HOST=clamav
EOF
chmod 600 "$APP_ENV_FILE"

cleanup() {
  docker compose stop postgres >/dev/null 2>&1 || true
  rm -f "$APP_ENV_FILE" /tmp/whatsapp-ai-backup-path
}
trap cleanup EXIT

echo "== deterministic dependency install =="
npm ci --ignore-scripts

echo "== lint =="
npm run lint

echo "== typecheck =="
npm run typecheck

echo "== PostgreSQL integration environment =="
docker compose up -d postgres
for _ in $(seq 1 60); do
  if docker compose exec -T postgres pg_isready -U whatsapp_ai -d whatsapp_ai >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

export NODE_ENV=test
export ZERO_COST_MODE=true
export DATABASE_URL="postgres://whatsapp_ai:$POSTGRES_PASSWORD@127.0.0.1:5432/whatsapp_ai"
export APP_ENCRYPTION_KEY="01234567890123456789012345678901"
export PII_HMAC_KEY="01234567890123456789012345678901"
export INTERNAL_API_KEY="test-internal-api-key-123456"
export LOCAL_AI_BASE_URL="http://127.0.0.1:11434"
export WHISPER_BASE_URL="http://127.0.0.1:8080"

echo "== migrations =="
npm run db:migrate

echo "== complete automated test matrix =="
npm test

echo "== TypeScript production build =="
npm run build

echo "== application container build =="
docker build -t whatsapp-ai:release-gate .

echo "== backup and restore rehearsal =="
BACKUP_DIR="$ROOT/.tmp/release-backup" bash scripts/backup.sh >/tmp/whatsapp-ai-backup-path
BACKUP_PATH="$(cat /tmp/whatsapp-ai-backup-path | tail -n 1)"
BACKUP_DIR="$ROOT/.tmp/release-backup" bash scripts/restore-rehearsal.sh "$BACKUP_PATH"

echo "== local security gate =="
SECURITY_IMAGE=whatsapp-ai:release-gate \
SECURITY_IMAGE_PREBUILT=true \
SECURITY_ARTIFACT_DIR="$ROOT/.tmp/security" \
  bash scripts/security-gate.sh

echo "== compose configuration validation =="
docker compose config --quiet

echo "Release Gate PASS"
