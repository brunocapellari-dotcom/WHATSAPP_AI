#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

for cmd in gcloud git node; do
  command -v "${cmd}" >/dev/null || {
    echo "required command missing: ${cmd}" >&2
    exit 1
  }
done

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
if [[ -z "${PROJECT_ID}" || "${PROJECT_ID}" == "(unset)" ]]; then
  echo "PROJECT_ID is not configured." >&2
  exit 2
fi

SOURCE_COMMIT="$(git rev-parse HEAD)"
BUCKET="${EVIDENCE_BUCKET:-${PROJECT_ID}-ai-execution-evidence}"
REMOTE="gs://${BUCKET}/WHATSAPP_AI/bootstrap/by-commit/${SOURCE_COMMIT}"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

gcloud storage cp "${REMOTE}/source-commit.txt" "${TMP}/source-commit.txt"
gcloud storage cp "${REMOTE}/generated-package-lock.json" "${TMP}/package-lock.json"

ARTIFACT_COMMIT="$(tr -d '\r\n' < "${TMP}/source-commit.txt")"
if [[ "${ARTIFACT_COMMIT}" != "${SOURCE_COMMIT}" ]]; then
  echo "Refusing lockfile: artifact commit ${ARTIFACT_COMMIT} != HEAD ${SOURCE_COMMIT}" >&2
  exit 3
fi

node --input-type=module - "${TMP}/package-lock.json" <<'NODE'
import fs from 'node:fs';

const candidatePath = process.argv[2];
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const lock = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));

if (lock.lockfileVersion !== 3) {
  throw new Error(`unexpected_lockfile_version:${lock.lockfileVersion}`);
}

const root = lock.packages?.[''];
if (!root) throw new Error('lockfile_missing_root_package');

function stableObject(value = {}) {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

const expectedDeps = stableObject(pkg.dependencies ?? {});
const actualDeps = stableObject(root.dependencies ?? {});
const expectedDev = stableObject(pkg.devDependencies ?? {});
const actualDev = stableObject(root.devDependencies ?? {});

if (JSON.stringify(expectedDeps) !== JSON.stringify(actualDeps)) {
  throw new Error('lockfile_root_dependencies_do_not_match_package_json');
}
if (JSON.stringify(expectedDev) !== JSON.stringify(actualDev)) {
  throw new Error('lockfile_root_devDependencies_do_not_match_package_json');
}

const xlsx = lock.packages?.['node_modules/xlsx'];
const expectedXlsx = pkg.dependencies?.xlsx;
if (
  expectedXlsx &&
  (!xlsx || xlsx.resolved !== expectedXlsx || !String(xlsx.integrity ?? '').startsWith('sha512-'))
) {
  throw new Error('xlsx_remote_dependency_not_integrity_pinned');
}
NODE

if [[ -f package-lock.json ]] && cmp -s package-lock.json "${TMP}/package-lock.json"; then
  echo "package-lock.json already matches the Cloud Build artifact for ${SOURCE_COMMIT}."
  exit 0
fi

cp "${TMP}/package-lock.json" package-lock.json
git add package-lock.json
git diff --cached --check
sha256sum package-lock.json

echo "Validated package-lock.json adopted from Cloud Build for ${SOURCE_COMMIT}."

if [[ "${COMMIT_LOCKFILE:-false}" == "true" ]]; then
  git commit -m "build: commit Cloud Build validated package lockfile"
fi

if [[ "${PUSH_LOCKFILE:-false}" == "true" ]]; then
  if [[ "${COMMIT_LOCKFILE:-false}" != "true" ]]; then
    echo "PUSH_LOCKFILE=true requires COMMIT_LOCKFILE=true." >&2
    exit 4
  fi
  git push origin HEAD
fi
