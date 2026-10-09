#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

fail() {
  echo "LOCAL_PAIR_FAIL: $*" >&2
  exit 2
}

[[ -f .env ]] || fail "run ./setup.sh first"

python3 - <<'PY'
from pathlib import Path
values = {}
for line in Path(".env").read_text(encoding="utf-8").splitlines():
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    values[key] = value
for key in ("WPP_SECRET_KEY", "WPP_SESSION_NAME"):
    if not values.get(key):
        raise SystemExit(f"missing {key} in .env")
PY

secret_key="$(python3 - <<'PY'
from pathlib import Path
values = {}
for line in Path(".env").read_text(encoding="utf-8").splitlines():
    if "=" in line and not line.startswith("#"):
        key, value = line.split("=", 1)
        values[key] = value
print(values["WPP_SECRET_KEY"])
PY
)"
session_name="$(python3 - <<'PY'
from pathlib import Path
values = {}
for line in Path(".env").read_text(encoding="utf-8").splitlines():
    if "=" in line and not line.startswith("#"):
        key, value = line.split("=", 1)
        values[key] = value
print(values["WPP_SESSION_NAME"])
PY
)"

token_cfg="$(mktemp)"
token_json="$(mktemp)"
start_cfg="$(mktemp)"
start_json="$(mktemp)"
trap 'rm -f "$token_cfg" "$token_json" "$start_cfg" "$start_json"; unset secret_key token' EXIT
chmod 600 "$token_cfg" "$token_json" "$start_cfg" "$start_json"

cat >"$token_cfg" <<EOF
url = "http://127.0.0.1:21465/api/manager/sessions/$session_name/token"
request = "POST"
header = "Authorization: Bearer $secret_key"
silent
show-error
fail-with-body
output = "$token_json"
EOF

curl --config "$token_cfg"

token="$(python3 - "$token_json" <<'PY'
import json
import sys
payload = json.load(open(sys.argv[1], encoding="utf-8"))
value = payload.get("token")
if not isinstance(value, str) or not value:
    raise SystemExit("session token was not returned")
print(value)
PY
)"

cat >"$start_cfg" <<EOF
url = "http://127.0.0.1:21465/api/$session_name/start-session"
request = "POST"
header = "Accept: application/json"
header = "Content-Type: application/json"
header = "Authorization: Bearer $token"
data = "{\"waitQrCode\":true}"
silent
show-error
fail-with-body
output = "$start_json"
EOF

curl --config "$start_cfg"

python3 - "$start_json" <<'PY'
import base64
import json
import os
import sys
from pathlib import Path

payload = json.load(open(sys.argv[1], encoding="utf-8"))
status = payload.get("status")
if status in {"CONNECTED", "connected"} or payload.get("connected") is True:
    print("LOCAL_PAIR_ALREADY_CONNECTED")
    raise SystemExit(0)

qr = payload.get("qrcode")
if not isinstance(qr, str) or not qr:
    raise SystemExit("QR was not returned; inspect local WPPConnect logs")
if qr.startswith("data:image/png;base64,"):
    qr = qr.split(",", 1)[1]
target = Path("pairing-qr.png")
target.write_bytes(base64.b64decode(qr, validate=True))
os.chmod(target, 0o600)
print(f"LOCAL_PAIR_QR_READY file={target}")
print("Open this local file and scan it with the dedicated authorized WhatsApp account.")
print("Do not upload or paste the QR, tokens or .env into chat.")
PY
