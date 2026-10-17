#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

fail() {
  echo "LOCAL_START_FAIL: $*" >&2
  exit 2
}

[[ -f .env ]] || fail "run ./setup.sh first"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"

set -a
# shellcheck disable=SC1091
source .env
set +a

[[ -n "${WPP_ALLOWED_CHAT_IDS:-}" ]] || fail "WPP_ALLOWED_CHAT_IDS must list explicitly authorized WhatsApp chats"
[[ "${WPP_ALLOWED_CHAT_IDS}" != "__UNCONFIGURED__" ]] || fail "configure WPP_ALLOWED_CHAT_IDS with explicitly authorized WhatsApp chat IDs before start"
[[ ${#WPP_INBOUND_WEBHOOK_SECRET} -ge 32 ]] || fail "WPP_INBOUND_WEBHOOK_SECRET must contain at least 32 characters"

docker compose --env-file .env config --quiet

docker compose --env-file .env up -d postgres
for _ in $(seq 1 30); do
  if docker compose --env-file .env exec -T postgres     pg_isready -U postgres -d whatsapp_ai >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
docker compose --env-file .env exec -T postgres   pg_isready -U postgres -d whatsapp_ai >/dev/null 2>&1   || fail "PostgreSQL did not become ready"

docker compose --env-file .env run --rm migrate
docker compose --env-file .env --profile bootstrap run --rm municipality-sync

docker compose --env-file .env up -d ingress bridge wppconnect report-scheduler

for _ in $(seq 1 30); do
  if curl --silent --show-error --fail --max-time 2     http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
curl --silent --show-error --fail --max-time 2   http://127.0.0.1:8080/readyz >/dev/null   || fail "WhatsApp AI ingress is not ready"

if [[ "${ENABLE_LOCAL_AGROLOG_DELIVERY:-0}" == "1" ]]; then
  docker compose --env-file .env --profile delivery up -d worker
  echo "delivery_worker=ENABLED"
else
  docker compose --env-file .env --profile delivery stop worker >/dev/null 2>&1 || true
  echo "delivery_worker=DISABLED"
  echo "reason=local AgroLog delivery was not explicitly enabled"
fi

echo "LOCAL_START_PASS"
echo "ingress=http://127.0.0.1:8080 (localhost only)"
echo "wppconnect=http://127.0.0.1:21465 (localhost only)"
echo "next=run ./pair.sh for the authorized WhatsApp account"
