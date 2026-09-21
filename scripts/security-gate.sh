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

require docker
require npm
require git

if [[ ! -f package-lock.json ]]; then
  echo "package-lock.json is mandatory for a release candidate." >&2
  echo "Run scripts/prepare-lockfile.sh on a network-enabled local machine and commit the result." >&2
  exit 1
fi

echo "== npm audit =="
npm audit --audit-level=high

echo "== Semgrep CE offline rules =="
docker run --rm   -e SEMGREP_SEND_METRICS=off   -v "$ROOT:/src"   semgrep/semgrep:1.177.0   semgrep scan --metrics=off --error --config=/src/.semgrep.yml /src/src /src/scripts

echo "== Gitleaks full repository history =="
docker run --rm   -v "$ROOT:/repo"   ghcr.io/gitleaks/gitleaks:v8.30.1   detect --source=/repo --no-banner --redact --verbose

echo "== Trivy filesystem/configuration =="
docker run --rm   -v "$ROOT:/work"   -w /work   aquasec/trivy:0.74.0   fs --scanners vuln,misconfig --severity HIGH,CRITICAL --exit-code 1 --ignore-unfixed .

echo "== Build production image for image scanning =="
docker build -t whatsapp-ai:release-gate .

echo "== Trivy production image =="
docker run --rm   -v /var/run/docker.sock:/var/run/docker.sock   aquasec/trivy:0.74.0   image --scanners vuln --severity HIGH,CRITICAL --exit-code 1 --ignore-unfixed whatsapp-ai:release-gate
