#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

npm install --package-lock-only --ignore-scripts
npm ci --ignore-scripts
npm run typecheck
npm test

echo
echo "package-lock.json generated and validated."
echo "Commit package-lock.json, then run scripts/release-gate.sh."
