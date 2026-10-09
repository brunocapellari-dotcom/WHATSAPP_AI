#!/usr/bin/env bash
set -euo pipefail
umask 077

PROJECT_ID="${PROJECT_ID:-}"
WEBHOOK_DOMAIN="${WEBHOOK_DOMAIN:-}"
WPP_SESSION_NAME="${WPP_SESSION_NAME:-freight-prod}"
BRIDGE_TENANT_ID="${BRIDGE_TENANT_ID:-freight-prod}"
BRIDGE_PROVIDER_ID="${BRIDGE_PROVIDER_ID:-wppconnect}"
PROVIDER_HMAC_SECRET_NAME="${PROVIDER_HMAC_SECRET_NAME:-whatsapp-ai-provider-webhook-secret}"
WEBHOOK_MAP_SECRET_NAME="${WEBHOOK_MAP_SECRET_NAME:-whatsapp-ai-webhook-secrets}"

fail() {
  echo "WPP_SETUP_FAIL: $*" >&2
  exit 2
}

[[ -n "$PROJECT_ID" ]] || fail "PROJECT_ID is required"
[[ "$WEBHOOK_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || fail "WEBHOOK_DOMAIN is invalid"
[[ "$WPP_SESSION_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || fail "WPP_SESSION_NAME is invalid"
[[ "$BRIDGE_TENANT_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || fail "BRIDGE_TENANT_ID is invalid"
[[ "$BRIDGE_PROVIDER_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || fail "BRIDGE_PROVIDER_ID is invalid"

for cmd in gcloud docker python3; do
  command -v "$cmd" >/dev/null 2>&1 || fail "$cmd is required"
done
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"
gcloud auth list --filter=status:ACTIVE --format='value(account)' | grep -q .   || fail "gcloud login is required"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

provider_hmac="$(gcloud secrets versions access latest   --secret="$PROVIDER_HMAC_SECRET_NAME"   --project="$PROJECT_ID")"
[[ -n "$provider_hmac" ]] || fail "provider HMAC secret is empty"

webhook_map="$(gcloud secrets versions access latest   --secret="$WEBHOOK_MAP_SECRET_NAME"   --project="$PROJECT_ID")"
printf '%s\n%s' "$provider_hmac" "$webhook_map" | python3 -c '
import hmac
import json
import sys

tenant, provider = sys.argv[1:]
expected, raw = sys.stdin.read().split("\n", 1)
mapping = json.loads(raw)
if not isinstance(mapping, dict):
    raise SystemExit("webhook secret mapping is not a JSON object")
actual = mapping.get(f"{tenant}:{provider}")
if not isinstance(actual, str) or not hmac.compare_digest(actual, expected):
    raise SystemExit("provider HMAC does not match cloud webhook mapping")
' "$BRIDGE_TENANT_ID" "$BRIDGE_PROVIDER_ID"
unset webhook_map

if [[ -f bridge.env || -f wpp.env ]]; then
  fail "bridge.env or wpp.env already exists; preserve the current session or rotate deliberately"
fi

wpp_secret="$(python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(48))
PY
)"
outbox_key="$(python3 - <<'PY'
import base64
import secrets
print(base64.b64encode(secrets.token_bytes(32)).decode())
PY
)"

cat >bridge.env <<EOF
BRIDGE_DB_PATH=/data/bridge/outbox.sqlite3
BRIDGE_OUTBOX_KEY_B64=$outbox_key
BRIDGE_TARGET_URL=https://$WEBHOOK_DOMAIN/v1/providers/$BRIDGE_PROVIDER_ID/events
BRIDGE_TENANT_ID=$BRIDGE_TENANT_ID
BRIDGE_PROVIDER_ID=$BRIDGE_PROVIDER_ID
BRIDGE_PROVIDER_HMAC_SECRET=$provider_hmac
BRIDGE_EGRESS_ALLOWED_HOSTS=$WEBHOOK_DOMAIN
BRIDGE_MAX_ATTEMPTS=8
BRIDGE_CLAIM_TIMEOUT_SECONDS=300
BRIDGE_FLUSH_INTERVAL_SECONDS=5
BRIDGE_MAX_WEBHOOK_BYTES=750000
WPP_ALLOWED_SESSIONS=$WPP_SESSION_NAME
EOF

cat >wpp.env <<EOF
SECRET_KEY=$wpp_secret
WPP_LOG_LEVEL=warn
EOF

chmod 600 bridge.env wpp.env
unset provider_hmac wpp_secret outbox_key

docker compose config --quiet
docker pull wppconnect/wppconnect-server:sha-c192518 >/dev/null
docker compose build bridge
docker compose up -d bridge wppconnect

for _ in $(seq 1 30); do
  if docker compose exec -T bridge python - <<'PY' >/dev/null 2>&1
import urllib.request
with urllib.request.urlopen("http://127.0.0.1:8081/healthz", timeout=2) as response:
    if response.status != 200:
        raise SystemExit(1)
PY
  then
    echo "WPP_BRIDGE_SETUP_PASS"
    echo "WPP API is bound only to http://127.0.0.1:21465"
    echo "Bridge has no published host port."
    echo "Session name: $WPP_SESSION_NAME"
    echo "Next human-only step: pair the authorized WhatsApp account locally."
    exit 0
  fi
  sleep 2
done

docker compose logs --tail=50 bridge >&2
fail "bridge health check did not become ready"
