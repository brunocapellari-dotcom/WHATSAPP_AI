#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

[[ -f .env ]] || { echo "LOCAL_STATUS_FAIL: run ./setup.sh first" >&2; exit 2; }

docker compose --env-file .env ps

echo
echo "Ingress health:"
curl --silent --show-error --fail --max-time 3   http://127.0.0.1:${LOCAL_INGRESS_PORT:-8080}/healthz || true
echo

echo "Ingress readiness:"
curl --silent --show-error --fail --max-time 3   http://127.0.0.1:${LOCAL_INGRESS_PORT:-8080}/readyz || true
echo

echo "Outbox status:"
set -a
# shellcheck disable=SC1091
source .env
set +a
docker compose --env-file .env exec -T postgres   psql -U postgres -d whatsapp_ai -Atc   "SELECT status || '=' || count(*) FROM whatsapp_agrolog_outbox GROUP BY status ORDER BY status;"   || true

echo "Bridge status:"
docker compose --env-file .env exec -T bridge   python - <<'PY' || true
import json
import urllib.request
with urllib.request.urlopen("http://127.0.0.1:8081/readyz", timeout=2) as response:
    print(json.dumps(json.load(response), sort_keys=True))
PY
