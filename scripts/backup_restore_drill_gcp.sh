#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-southamerica-east1}"
SOURCE_INSTANCE="${CLOUD_SQL_INSTANCE_NAME:-whatsapp-ai-postgres}"
INGRESS_SERVICE_NAME="${INGRESS_SERVICE_NAME:-whatsapp-ai-ingress}"
RESTORE_SA_NAME="${RESTORE_SA_NAME:-whatsapp-ai-restore-drill}"
DB_MIGRATOR_SECRET="${DB_MIGRATOR_SECRET:-whatsapp-ai-database-url-migrator}"
ALLOW_BILLABLE_RESTORE_DRILL="${ALLOW_BILLABLE_RESTORE_DRILL:-0}"
RUN_TOKEN="${GITHUB_RUN_ID:-$(date +%s)}"

fail() {
  echo "RESTORE_DRILL_FAIL: $*" >&2
  exit 2
}

[[ "$ALLOW_BILLABLE_RESTORE_DRILL" == "1" ]]   || fail "explicit billable restore-drill confirmation is required"
[[ -n "$PROJECT_ID" ]] || fail "PROJECT_ID is required"
[[ "$SOURCE_INSTANCE" =~ ^[a-z][a-z0-9-]{0,97}$ ]]   || fail "invalid source Cloud SQL instance name"
[[ "$RUN_TOKEN" =~ ^[A-Za-z0-9._-]+$ ]] || fail "invalid run token"

for cmd in gcloud python3 curl; do
  command -v "$cmd" >/dev/null 2>&1 || fail "$cmd is required"
done

gcloud config set project "$PROJECT_ID" >/dev/null

active_account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n1)"
restore_sa="${RESTORE_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
[[ "$active_account" == "$restore_sa" ]]   || fail "restore drill must run as dedicated identity: $restore_sa"

source_state="$(gcloud sql instances describe "$SOURCE_INSTANCE"   --project "$PROJECT_ID" --format='value(state)' 2>/dev/null || true)"
[[ "$source_state" == "RUNNABLE" ]] || fail "source instance is not RUNNABLE"

image="$(gcloud run services describe "$INGRESS_SERVICE_NAME"   --region "$REGION" --project "$PROJECT_ID"   --format='value(spec.template.spec.containers[0].image)' 2>/dev/null || true)"
[[ -n "$image" ]] || fail "deployed ingress image could not be resolved"

safe_token="$(printf '%s' "$RUN_TOKEN" | tr '[:upper:]_.' '[:lower:]--' | cut -c1-24)"
source_prefix="$(printf '%s' "$SOURCE_INSTANCE" | cut -c1-55)"
target_instance="${source_prefix}-restore-drill-${safe_token}"
validation_job="whatsapp-ai-restore-validate-${safe_token}"
backup_description="whatsapp-ai-restore-drill-${RUN_TOKEN}"

[[ "$target_instance" != "$SOURCE_INSTANCE" ]] || fail "target instance equals production source"
[[ "$target_instance" == *"-restore-drill-"* ]] || fail "unsafe target instance name"
[[ "$validation_job" == whatsapp-ai-restore-validate-* ]] || fail "unsafe validation job name"

cleanup() {
  local code=$?
  set +e
  gcloud run jobs delete "$validation_job"     --region "$REGION" --project "$PROJECT_ID" --quiet >/dev/null 2>&1
  if gcloud sql instances describe "$target_instance" --project "$PROJECT_ID" >/dev/null 2>&1; then
    gcloud sql instances patch "$target_instance"       --project "$PROJECT_ID" --no-deletion-protection --quiet >/dev/null 2>&1
    gcloud sql instances delete "$target_instance"       --project "$PROJECT_ID" --quiet >/dev/null 2>&1
  fi
  if [[ "$code" -ne 0 ]]; then
    echo "RESTORE_DRILL_CLEANUP_COMPLETE_AFTER_FAILURE" >&2
  fi
  exit "$code"
}
trap cleanup EXIT

if gcloud sql instances describe "$target_instance" --project "$PROJECT_ID" >/dev/null 2>&1; then
  fail "temporary restore instance already exists: $target_instance"
fi

echo "Creating on-demand backup (source data is not modified)"
gcloud sql backups create   --instance="$SOURCE_INSTANCE"   --project="$PROJECT_ID"   --description="$backup_description"   --quiet >/dev/null

backup_json="$(mktemp)"
gcloud sql backups list   --instance="$SOURCE_INSTANCE"   --project="$PROJECT_ID"   --format=json >"$backup_json"

backup_id="$(python3 - "$backup_json" "$backup_description" <<'PY'
import json
import sys

path, description = sys.argv[1:]
items = json.load(open(path, encoding="utf-8"))
matches = [
    item
    for item in items
    if item.get("description") == description
    and item.get("status") == "SUCCESSFUL"
]
if not matches:
    raise SystemExit("successful on-demand backup not found")
matches.sort(key=lambda item: int(item.get("id", 0)), reverse=True)
print(matches[0]["id"])
PY
)"
rm -f "$backup_json"
[[ "$backup_id" =~ ^[0-9]+$ ]] || fail "invalid backup id"

echo "Restoring backup $backup_id into isolated temporary instance"
gcloud sql backups restore "$backup_id"   --restore-instance="$target_instance"   --backup-instance="$SOURCE_INSTANCE"   --project="$PROJECT_ID"   --quiet >/dev/null

target_state="$(gcloud sql instances describe "$target_instance"   --project "$PROJECT_ID" --format='value(state)' 2>/dev/null || true)"
[[ "$target_state" == "RUNNABLE" ]] || fail "restored target is not RUNNABLE"

target_connection="$(gcloud sql instances describe "$target_instance"   --project "$PROJECT_ID" --format='value(connectionName)')"
[[ -n "$target_connection" ]] || fail "restore target connection name missing"

echo "Validating restored schema, migration ledger and RLS in isolated job"
gcloud run jobs deploy "$validation_job"   --image "$image"   --region "$REGION"   --project "$PROJECT_ID"   --service-account "$restore_sa"   --set-cloudsql-instances "$target_connection"   --update-secrets "DATABASE_URL_SOURCE_MIGRATOR=${DB_MIGRATOR_SECRET}:latest"   --set-env-vars "RESTORE_CONNECTION_NAME=${target_connection}"   --command python   --args=-m,scripts.validate_restored_database   --max-retries 0   --task-timeout 10m   --quiet

gcloud run jobs execute "$validation_job"   --region "$REGION" --project "$PROJECT_ID" --wait >/dev/null

validation_log=""
for _ in $(seq 1 12); do
  validation_log="$(gcloud logging read     "resource.type=cloud_run_job AND resource.labels.job_name=\"$validation_job\" AND textPayload:\"RESTORE_VALIDATION_PASS\""     --project="$PROJECT_ID"     --limit=1     --freshness=30m     --format='value(textPayload)' 2>/dev/null || true)"
  [[ "$validation_log" == *"RESTORE_VALIDATION_PASS"* ]] && break
  sleep 5
done
[[ "$validation_log" == *"RESTORE_VALIDATION_PASS"* ]]   || fail "restore validation job completed but PASS evidence was not found in logs"

echo "$validation_log"
echo "RESTORE_DRILL_PASS backup_id=$backup_id target=$target_instance"

cleanup_code=0
trap - EXIT
set +e
gcloud run jobs delete "$validation_job"   --region "$REGION" --project "$PROJECT_ID" --quiet >/dev/null 2>&1
gcloud sql instances patch "$target_instance"   --project "$PROJECT_ID" --no-deletion-protection --quiet >/dev/null 2>&1
gcloud sql instances delete "$target_instance"   --project "$PROJECT_ID" --quiet >/dev/null 2>&1 || cleanup_code=$?
set -e
[[ "$cleanup_code" -eq 0 ]] || fail "validation passed but temporary instance cleanup failed"
echo "RESTORE_DRILL_TEMP_INSTANCE_DELETED"
