#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-southamerica-east1}"
CLOUD_SQL_INSTANCE_NAME="${CLOUD_SQL_INSTANCE_NAME:-whatsapp-ai-postgres}"
AR_REPOSITORY="${AR_REPOSITORY:-whatsapp-ai}"
BUILD_SOURCE_BUCKET="${BUILD_SOURCE_BUCKET:-${PROJECT_ID}-whatsapp-ai-build-source}"
BUILD_SERVICE_ACCOUNT="${BUILD_SERVICE_ACCOUNT:-}"
INGRESS_SA_NAME="${INGRESS_SA_NAME:-whatsapp-ai-ingress}"
WORKER_SA_NAME="${WORKER_SA_NAME:-whatsapp-ai-worker}"
MIGRATOR_SA_NAME="${MIGRATOR_SA_NAME:-whatsapp-ai-migrator}"
AGROLOG_SERVICE_NAME="${AGROLOG_SERVICE_NAME:-agrolog-freight-ingest}"
WHATSAPP_WORKER_TENANT_ID="${WHATSAPP_WORKER_TENANT_ID:-}"
DB_INGRESS_SECRET="${DB_INGRESS_SECRET:-whatsapp-ai-database-url}"
DB_WORKER_SECRET="${DB_WORKER_SECRET:-whatsapp-ai-database-url-worker}"
DB_MIGRATOR_SECRET="${DB_MIGRATOR_SECRET:-whatsapp-ai-database-url-migrator}"
RAW_KEY_SECRET="${RAW_KEY_SECRET:-whatsapp-ai-raw-encryption-key}"
WEBHOOK_SECRETS_SECRET="${WEBHOOK_SECRETS_SECRET:-whatsapp-ai-webhook-secrets}"
AGROLOG_SHARED_SECRET_NAME="${AGROLOG_SHARED_SECRET_NAME:-agrolog-freight-shared-secret}"

fail() {
  echo "PREFLIGHT_FAIL: $*" >&2
  exit 2
}

[[ -n "$PROJECT_ID" ]] || fail "PROJECT_ID is required"
[[ -n "$BUILD_SERVICE_ACCOUNT" ]] || fail "BUILD_SERVICE_ACCOUNT is required"
[[ -n "$WHATSAPP_WORKER_TENANT_ID" ]] || fail "WHATSAPP_WORKER_TENANT_ID is required"

for cmd in gcloud python3; do
  command -v "$cmd" >/dev/null 2>&1 || fail "$cmd is not installed"
done

gcloud config set project "$PROJECT_ID" >/dev/null

active_account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n1)"
[[ -n "$active_account" ]] || fail "no active gcloud identity"

if [[ -n "${EXPECTED_DEPLOYER_SA:-}" && "$active_account" != "$EXPECTED_DEPLOYER_SA" ]]; then
  fail "unexpected deploy identity: $active_account"
fi

sql_state="$(gcloud sql instances describe "$CLOUD_SQL_INSTANCE_NAME"   --project "$PROJECT_ID" --format='value(state)' 2>/dev/null || true)"
[[ "$sql_state" == "RUNNABLE" ]] || fail "Cloud SQL instance is absent or not RUNNABLE"

connection_name="$(gcloud sql instances describe "$CLOUD_SQL_INSTANCE_NAME"   --project "$PROJECT_ID" --format='value(connectionName)')"
[[ -n "$connection_name" ]] || fail "Cloud SQL connectionName is empty"

for sa in   "${INGRESS_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"   "${WORKER_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"   "${MIGRATOR_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"   "$BUILD_SERVICE_ACCOUNT"; do
  gcloud iam service-accounts describe "$sa" --project "$PROJECT_ID" >/dev/null 2>&1     || fail "service account missing: $sa"
done

gcloud artifacts repositories describe "$AR_REPOSITORY"   --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1   || fail "Artifact Registry repository missing: $AR_REPOSITORY"

gcloud storage buckets describe "gs://${BUILD_SOURCE_BUCKET}"   --project "$PROJECT_ID" >/dev/null 2>&1   || fail "build source bucket missing: gs://${BUILD_SOURCE_BUCKET}"

for secret in   "$DB_INGRESS_SECRET"   "$DB_WORKER_SECRET"   "$DB_MIGRATOR_SECRET"   "$RAW_KEY_SECRET"   "$WEBHOOK_SECRETS_SECRET"   "$AGROLOG_SHARED_SECRET_NAME"; do
  gcloud secrets describe "$secret" --project "$PROJECT_ID" >/dev/null 2>&1     || fail "Secret Manager secret missing: $secret"
  gcloud secrets versions list "$secret" --project "$PROJECT_ID"     --filter='state=ENABLED' --format='value(name)' | grep -q .     || fail "secret has no enabled version: $secret"
done

agrolog_url="$(gcloud run services describe "$AGROLOG_SERVICE_NAME"   --region "$REGION" --project "$PROJECT_ID" --format='value(status.url)' 2>/dev/null || true)"
[[ "$agrolog_url" == https://* ]] || fail "private AgroLog freight service is missing or has no HTTPS URL"

broad_binding="$(gcloud run services get-iam-policy "$AGROLOG_SERVICE_NAME"   --region "$REGION" --project "$PROJECT_ID"   --flatten='bindings[].members'   --filter='bindings.role=roles/run.invoker AND (bindings.members=allUsers OR bindings.members=allAuthenticatedUsers)'   --format='value(bindings.members)' | head -n1)"
if [[ "$broad_binding" == "allUsers" || "$broad_binding" == "allAuthenticatedUsers" ]]; then
  fail "AgroLog freight service has a broad public invoker binding"
fi

worker_sa="${WORKER_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
worker_invoker="$(gcloud run services get-iam-policy "$AGROLOG_SERVICE_NAME" \
  --region "$REGION" --project "$PROJECT_ID" \
  --flatten='bindings[].members' \
  --filter="bindings.role=roles/run.invoker AND bindings.members=serviceAccount:${worker_sa}" \
  --format='value(bindings.members)' | head -n1)"
[[ "$worker_invoker" == "serviceAccount:${worker_sa}" ]] \
  || fail "worker service account lacks service-level roles/run.invoker on AgroLog freight service"

echo "PREFLIGHT_PASS"
echo "project=$PROJECT_ID"
echo "region=$REGION"
echo "cloud_sql_connection=$connection_name"
echo "agrolog_service=$AGROLOG_SERVICE_NAME"
echo "worker_tenant=$WHATSAPP_WORKER_TENANT_ID"
echo "secrets=READY (values not displayed)"
