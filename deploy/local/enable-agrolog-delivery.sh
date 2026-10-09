#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

[[ -f .env ]] || { echo "LOCAL_DELIVERY_FAIL: run ./setup.sh first" >&2; exit 2; }

agrolog_url="${1:-}"
[[ "$agrolog_url" == http://* ]] || {
  echo "LOCAL_DELIVERY_FAIL: pass local AgroLog URL, for example http://host.docker.internal:8000/v1/freight/events" >&2
  exit 2
}

host="$(python3 - "$agrolog_url" <<'PY'
import sys
from urllib.parse import urlparse
parsed = urlparse(sys.argv[1])
if parsed.scheme != "http" or parsed.hostname not in {"host.docker.internal", "agrolog"}:
    raise SystemExit("AgroLog URL must use an approved local service hostname")
if parsed.path != "/v1/freight/events":
    raise SystemExit("AgroLog URL path must be exactly /v1/freight/events")
print(parsed.hostname)
PY
)"

python3 - "$agrolog_url" "$host" <<'PY'
import sys
from pathlib import Path

path = Path(".env")
url, host = sys.argv[1:]
lines = path.read_text(encoding="utf-8").splitlines()
replace = {
    "LOCAL_AGROLOG_URL": url,
    "LOCAL_AGROLOG_HOST": host,
    "ENABLE_LOCAL_AGROLOG_DELIVERY": "1",
}
seen = set()
out = []
for line in lines:
    if "=" not in line or line.startswith("#"):
        out.append(line)
        continue
    key, _ = line.split("=", 1)
    if key in replace:
        out.append(f"{key}={replace[key]}")
        seen.add(key)
    else:
        out.append(line)
for key, value in replace.items():
    if key not in seen:
        out.append(f"{key}={value}")
path.write_text("\n".join(out) + "\n", encoding="utf-8")
path.chmod(0o600)
PY

docker compose --env-file .env --profile delivery up -d worker
echo "LOCAL_AGROLOG_DELIVERY_ENABLED url=$agrolog_url"
echo "The AGROLOG_SHARED_SECRET in deploy/local/.env must match the local AgroLog receiver secret."
