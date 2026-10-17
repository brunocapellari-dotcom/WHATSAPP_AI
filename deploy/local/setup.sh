#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

fail() {
  echo "LOCAL_SETUP_FAIL: $*" >&2
  exit 2
}

for cmd in docker python3; do
  command -v "$cmd" >/dev/null 2>&1 || fail "$cmd is required"
done
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"

if [[ -f .env ]]; then
  fail "deploy/local/.env already exists; preserve it or rotate secrets deliberately"
fi

token_hex() {
  python3 - <<'PY'
import secrets
print(secrets.token_hex(24))
PY
}

token_urlsafe() {
  python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(48))
PY
}

base64_key() {
  python3 - <<'PY'
import base64
import secrets
print(base64.b64encode(secrets.token_bytes(32)).decode())
PY
}

POSTGRES_ADMIN_PASSWORD="$(token_hex)"
DB_INGEST_PASSWORD="$(token_hex)"
DB_WORKER_PASSWORD="$(token_hex)"
WHATSAPP_RAW_ENCRYPTION_KEY_B64="$(base64_key)"
BRIDGE_OUTBOX_KEY_B64="$(base64_key)"
PROVIDER_HMAC_SECRET="$(token_urlsafe)"
WPP_SECRET_KEY="$(token_urlsafe)"
WPP_INBOUND_WEBHOOK_SECRET="$(token_urlsafe)"
AGROLOG_SHARED_SECRET="$(token_urlsafe)"

cat >.env <<EOF
LOCAL_TENANT_ID=freight-prod
LOCAL_PROVIDER_ID=wppconnect
WPP_SESSION_NAME=freight-prod
WPP_ALLOWED_CHAT_IDS=__UNCONFIGURED__
WPP_INBOUND_WEBHOOK_SECRET=$WPP_INBOUND_WEBHOOK_SECRET

POSTGRES_ADMIN_PASSWORD=$POSTGRES_ADMIN_PASSWORD
DB_INGEST_PASSWORD=$DB_INGEST_PASSWORD
DB_WORKER_PASSWORD=$DB_WORKER_PASSWORD

WHATSAPP_RAW_ENCRYPTION_KEY_B64=$WHATSAPP_RAW_ENCRYPTION_KEY_B64
BRIDGE_OUTBOX_KEY_B64=$BRIDGE_OUTBOX_KEY_B64
PROVIDER_HMAC_SECRET=$PROVIDER_HMAC_SECRET
WPP_SECRET_KEY=$WPP_SECRET_KEY

LOCAL_AGROLOG_HOST=host.docker.internal
LOCAL_AGROLOG_URL=http://host.docker.internal:8000/v1/freight/events
AGROLOG_SHARED_SECRET=$AGROLOG_SHARED_SECRET
ENABLE_LOCAL_AGROLOG_DELIVERY=0
EOF

chmod 600 .env
unset   POSTGRES_ADMIN_PASSWORD   DB_INGEST_PASSWORD   DB_WORKER_PASSWORD   WHATSAPP_RAW_ENCRYPTION_KEY_B64   BRIDGE_OUTBOX_KEY_B64   PROVIDER_HMAC_SECRET   WPP_SECRET_KEY   WPP_INBOUND_WEBHOOK_SECRET   AGROLOG_SHARED_SECRET

docker compose --env-file .env config --quiet

echo "LOCAL_SETUP_PASS"
echo "secrets_file=$SCRIPT_DIR/.env (mode 0600)"
echo "cloud_cost=0"
echo "public_ports=none"
echo "localhost_ports=8080,21465"
echo "next=run ./start.sh"
echo "Do not upload, paste or commit deploy/local/.env."
