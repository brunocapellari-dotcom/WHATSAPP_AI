#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

SESSION_NAME="${WPP_SESSION_NAME:-freight-prod}"
[[ "$SESSION_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ ]] || {
  echo "PAIR_FAIL: invalid WPP_SESSION_NAME" >&2
  exit 2
}
[[ -f wpp.env ]] || {
  echo "PAIR_FAIL: run setup.sh first" >&2
  exit 2
}

secret_key="$(python3 - <<'PY'
from pathlib import Path

values = {}
for line in Path("wpp.env").read_text(encoding="utf-8").splitlines():
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    values[key] = value
secret = values.get("SECRET_KEY")
if not secret:
    raise SystemExit("SECRET_KEY missing from wpp.env")
print(secret)
PY
)"

token_cfg="$(mktemp)"
token_json="$(mktemp)"
start_cfg="$(mktemp)"
start_json="$(mktemp)"
trap 'rm -f "$token_cfg" "$token_json" "$start_cfg" "$start_json"; unset secret_key token' EXIT
chmod 600 "$token_cfg" "$token_json" "$start_cfg" "$start_json"

cat >"$token_cfg" <<EOF
url = "http://127.0.0.1:21465/api/manager/sessions/$SESSION_NAME/token"
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
token = payload.get("token")
if not isinstance(token, str) or not token:
    raise SystemExit("session token was not returned")
print(token)
PY
)"

cat >"$start_cfg" <<EOF
url = "http://127.0.0.1:21465/api/$SESSION_NAME/start-session"
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
    print("PAIR_ALREADY_CONNECTED")
    raise SystemExit(0)

qr = payload.get("qrcode")
if not isinstance(qr, str) or not qr:
    raise SystemExit(
        "QR was not returned. Check: docker compose logs --tail=100 wppconnect"
    )
if qr.startswith("data:image/png;base64,"):
    qr = qr.split(",", 1)[1]
target = Path("pairing-qr.png")
target.write_bytes(base64.b64decode(qr, validate=True))
os.chmod(target, 0o600)
print(f"PAIR_QR_READY file={target}")
print("Open the local PNG and scan it with the authorized WhatsApp account.")
print("Do not upload or paste the QR, token or wpp.env into chat.")
PY
