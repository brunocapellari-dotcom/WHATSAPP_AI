#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
VENV="$SCRIPT_DIR/.local-ci-venv"
PG_NAME="whatsapp-ai-local-ci-postgres"

fail() {
  echo "LOCAL_CI_FAIL: $*" >&2
  exit 2
}

for cmd in docker python3 node; do
  command -v "$cmd" >/dev/null 2>&1 || fail "$cmd is required"
done
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"

cleanup() {
  docker rm -f "$PG_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

cd "$ROOT_DIR"
for f in scripts/*.sh provider/wppconnect/*.sh deploy/local/*.sh; do bash -n "$f"; done
node --check provider/wppconnect/wpp-entrypoint.cjs
docker compose   --env-file deploy/local/.env.example   -f deploy/local/docker-compose.yml   config --quiet

if [[ ! -x "$VENV/bin/python" ]]; then
  python3 -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"
python -m pip install --upgrade pip
pip install -e ".[test]"
python -m pip check

docker run -d --rm   --name "$PG_NAME"   -e POSTGRES_USER=postgres   -e POSTGRES_PASSWORD=postgres   -e POSTGRES_DB=whatsapp_ai_test   -p 127.0.0.1:55432:5432   postgres:17-alpine >/dev/null

for _ in $(seq 1 30); do
  if docker exec "$PG_NAME" pg_isready -U postgres -d whatsapp_ai_test >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
docker exec "$PG_NAME" pg_isready -U postgres -d whatsapp_ai_test >/dev/null   || fail "ephemeral PostgreSQL did not become ready"

export TEST_DATABASE_URL_ADMIN="postgresql://postgres:postgres@127.0.0.1:55432/whatsapp_ai_test"

ruff check app scripts tests
mypy --ignore-missing-imports --check-untyped-defs app scripts
bandit -q -r app scripts
python -m compileall -q app scripts
pytest
docker build --pull --tag whatsapp-ai:local-ci .

echo "LOCAL_CI_PASS"
echo "github_actions_required=false"
