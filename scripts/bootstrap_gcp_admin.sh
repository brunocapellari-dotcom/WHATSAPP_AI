#!/usr/bin/env bash
set -euo pipefail

REPO="${REPO:-brunocapellari-dotcom/WHATSAPP_AI}"
PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-southamerica-east1}"
ALLOW_BILLABLE_INFRA="${ALLOW_BILLABLE_INFRA:-0}"
CLOUD_SQL_INSTANCE_NAME="${CLOUD_SQL_INSTANCE_NAME:-whatsapp-ai-postgres}"
CLOUD_SQL_CPU="${CLOUD_SQL_CPU:-}"
CLOUD_SQL_MEMORY_MB="${CLOUD_SQL_MEMORY_MB:-}"
CLOUD_SQL_STORAGE_GB="${CLOUD_SQL_STORAGE_GB:-}"
CLOUD_SQL_AVAILABILITY_TYPE="${CLOUD_SQL_AVAILABILITY_TYPE:-}"
DB_NAME="${DB_NAME:-whatsapp_ai}"
AR_REPOSITORY="${AR_REPOSITORY:-whatsapp-ai}"
BUILD_SOURCE_BUCKET="${BUILD_SOURCE_BUCKET:-${PROJECT_ID}-whatsapp-ai-build-source}"
POOL_ID="${POOL_ID:-github}"
PROVIDER_ID="${PROVIDER_ID:-whatsapp-ai}"

DEPLOYER_SA_NAME="${DEPLOYER_SA_NAME:-whatsapp-ai-github-deployer}"
BUILD_SA_NAME="${BUILD_SA_NAME:-whatsapp-ai-builder}"
INGRESS_SA_NAME="${INGRESS_SA_NAME:-whatsapp-ai-ingress}"
WORKER_SA_NAME="${WORKER_SA_NAME:-whatsapp-ai-worker}"
MIGRATOR_SA_NAME="${MIGRATOR_SA_NAME:-whatsapp-ai-migrator}"
RESTORE_SA_NAME="${RESTORE_SA_NAME:-whatsapp-ai-restore-drill}"

DB_INGEST_USER="${DB_INGEST_ROLE:-whatsapp_ingest_app}"
DB_WORKER_USER="${DB_WORKER_ROLE:-whatsapp_worker_app}"
DB_MIGRATOR_USER="${DB_MIGRATOR_USER:-whatsapp_migrator}"

DB_INGRESS_SECRET="${DB_INGRESS_SECRET:-whatsapp-ai-database-url}"
DB_WORKER_SECRET="${DB_WORKER_SECRET:-whatsapp-ai-database-url-worker}"
DB_MIGRATOR_SECRET="${DB_MIGRATOR_SECRET:-whatsapp-ai-database-url-migrator}"
RAW_KEY_SECRET="${RAW_KEY_SECRET:-whatsapp-ai-raw-encryption-key}"
WEBHOOK_SECRETS_SECRET="${WEBHOOK_SECRETS_SECRET:-whatsapp-ai-webhook-secrets}"
PROVIDER_HMAC_SECRET="${PROVIDER_HMAC_SECRET:-whatsapp-ai-provider-webhook-secret}"
AGROLOG_SHARED_SECRET_NAME="${AGROLOG_SHARED_SECRET_NAME:-agrolog-freight-shared-secret}"
AGROLOG_SERVICE_NAME="${AGROLOG_SERVICE_NAME:-agrolog-freight-ingest}"
WHATSAPP_TENANT_ID="${WHATSAPP_TENANT_ID:-freight-prod}"
WHATSAPP_PROVIDER_ID="${WHATSAPP_PROVIDER_ID:-wppconnect}"

fail() {
  echo "BOOTSTRAP_FAIL: $*" >&2
  exit 2
}

[[ "$ALLOW_BILLABLE_INFRA" == "1" ]] || fail "set ALLOW_BILLABLE_INFRA=1 only after OWNER accepts Cloud SQL/runtime costs"
[[ -n "$PROJECT_ID" ]] || fail "PROJECT_ID is required"
[[ "$CLOUD_SQL_CPU" =~ ^[0-9]+$ ]] || fail "CLOUD_SQL_CPU must be explicit"
[[ "$CLOUD_SQL_MEMORY_MB" =~ ^[0-9]+$ ]] || fail "CLOUD_SQL_MEMORY_MB must be explicit"
[[ "$CLOUD_SQL_STORAGE_GB" =~ ^[0-9]+$ ]] || fail "CLOUD_SQL_STORAGE_GB must be explicit"
case "$CLOUD_SQL_AVAILABILITY_TYPE" in ZONAL|REGIONAL) ;; *) fail "CLOUD_SQL_AVAILABILITY_TYPE must be ZONAL or REGIONAL" ;; esac
[[ "$WHATSAPP_TENANT_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || fail "invalid WHATSAPP_TENANT_ID"
[[ "$WHATSAPP_PROVIDER_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || fail "invalid WHATSAPP_PROVIDER_ID"

for cmd in gcloud gh python3; do
  command -v "$cmd" >/dev/null 2>&1 || fail "$cmd is required"
done
gcloud auth list --filter=status:ACTIVE --format='value(account)' | grep -q . || fail "gcloud login required"
gh auth status >/dev/null 2>&1 || fail "GitHub CLI login required"

gcloud config set project "$PROJECT_ID" >/dev/null

REPO_NUMERIC_ID="$(gh api "repos/${REPO}" --jq '.id')"
OWNER_NUMERIC_ID="$(gh api "repos/${REPO}" --jq '.owner.id')"
[[ "$REPO_NUMERIC_ID" =~ ^[0-9]+$ ]] || fail "repository numeric id unavailable"
[[ "$OWNER_NUMERIC_ID" =~ ^[0-9]+$ ]] || fail "owner numeric id unavailable"

gcloud services enable   run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com   cloudbuild.googleapis.com artifactregistry.googleapis.com   iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com   storage.googleapis.com logging.googleapis.com compute.googleapis.com   --project "$PROJECT_ID"

ensure_sa() {
  local name="$1" display="$2"
  local email="${name}@${PROJECT_ID}.iam.gserviceaccount.com"
  if ! gcloud iam service-accounts describe "$email" --project "$PROJECT_ID" >/dev/null 2>&1; then
    gcloud iam service-accounts create "$name" --project "$PROJECT_ID" --display-name="$display"
  fi
}

ensure_project_role() {
  local principal="$1" role="$2"
  gcloud projects add-iam-policy-binding "$PROJECT_ID"     --member="serviceAccount:${principal}" --role="$role" --condition=None --quiet >/dev/null
}

ensure_secret_container() {
  local name="$1"
  if ! gcloud secrets describe "$name" --project "$PROJECT_ID" >/dev/null 2>&1; then
    gcloud secrets create "$name" --project "$PROJECT_ID" --replication-policy=automatic >/dev/null
  fi
}

secret_has_version() {
  gcloud secrets versions list "$1" --project "$PROJECT_ID"     --filter='state=ENABLED' --format='value(name)' | grep -q .
}

add_secret_value() {
  local name="$1" value="$2"
  ensure_secret_container "$name"
  printf '%s' "$value" | gcloud secrets versions add "$name"     --project "$PROJECT_ID" --data-file=- >/dev/null
}

random_token() {
  python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(48))
PY
}

ensure_sa "$DEPLOYER_SA_NAME" "WhatsApp AI GitHub deployer"
ensure_sa "$BUILD_SA_NAME" "WhatsApp AI Cloud Build"
ensure_sa "$INGRESS_SA_NAME" "WhatsApp AI ingress runtime"
ensure_sa "$WORKER_SA_NAME" "WhatsApp AI outbox worker"
ensure_sa "$MIGRATOR_SA_NAME" "WhatsApp AI migration runtime"
ensure_sa "$RESTORE_SA_NAME" "WhatsApp AI restore drill"

DEPLOYER_SA_EMAIL="${DEPLOYER_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
BUILD_SA_EMAIL="${BUILD_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
INGRESS_SA_EMAIL="${INGRESS_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
WORKER_SA_EMAIL="${WORKER_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
MIGRATOR_SA_EMAIL="${MIGRATOR_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
RESTORE_SA_EMAIL="${RESTORE_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

if ! gcloud artifacts repositories describe "$AR_REPOSITORY"   --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud artifacts repositories create "$AR_REPOSITORY"     --repository-format=docker --location "$REGION" --project "$PROJECT_ID"
fi

if ! gcloud storage buckets describe "gs://${BUILD_SOURCE_BUCKET}"   --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${BUILD_SOURCE_BUCKET}"     --project "$PROJECT_ID" --location "$REGION" --uniform-bucket-level-access
fi
gcloud storage buckets update "gs://${BUILD_SOURCE_BUCKET}"   --public-access-prevention=enforced >/dev/null

if ! gcloud sql instances describe "$CLOUD_SQL_INSTANCE_NAME"   --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud sql instances create "$CLOUD_SQL_INSTANCE_NAME"     --project "$PROJECT_ID"     --database-version=POSTGRES_17     --edition=ENTERPRISE     --region="$REGION"     --cpu="$CLOUD_SQL_CPU"     --memory="${CLOUD_SQL_MEMORY_MB}MB"     --storage-type=SSD     --storage-size="${CLOUD_SQL_STORAGE_GB}GB"     --storage-auto-increase     --availability-type="$CLOUD_SQL_AVAILABILITY_TYPE"     --backup-start-time=04:00     --retained-backups-count=14     --enable-point-in-time-recovery     --retained-transaction-log-days=7     --deletion-protection     --enable-password-policy     --password-policy-min-length=20     --password-policy-complexity=COMPLEXITY_DEFAULT
fi

sql_state="$(gcloud sql instances describe "$CLOUD_SQL_INSTANCE_NAME"   --project "$PROJECT_ID" --format='value(state)')"
[[ "$sql_state" == "RUNNABLE" ]] || fail "Cloud SQL instance is not RUNNABLE"

if ! gcloud sql databases describe "$DB_NAME" --instance "$CLOUD_SQL_INSTANCE_NAME"   --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud sql databases create "$DB_NAME" --instance "$CLOUD_SQL_INSTANCE_NAME" --project "$PROJECT_ID"
fi

CONNECTION_NAME="$(gcloud sql instances describe "$CLOUD_SQL_INSTANCE_NAME"   --project "$PROJECT_ID" --format='value(connectionName)')"
[[ -n "$CONNECTION_NAME" ]] || fail "Cloud SQL connection name unavailable"

make_dsn() {
  local user="$1" password="$2"
  python3 - "$user" "$password" "$DB_NAME" "$CONNECTION_NAME" <<'PY'
import sys
from urllib.parse import quote
user, password, db, conn = sys.argv[1:]
print(
    f"postgresql://{quote(user, safe='')}:{quote(password, safe='')}@/{quote(db, safe='')}"
    f"?host={quote('/cloudsql/' + conn, safe='')}&sslmode=disable"
)
PY
}

ensure_db_user_and_secret() {
  local user="$1" secret="$2"
  local user_exists=0 secret_exists=0
  gcloud sql users list --instance "$CLOUD_SQL_INSTANCE_NAME" --project "$PROJECT_ID"     --filter="name=${user}" --format='value(name)' | grep -Fxq "$user" && user_exists=1 || true
  ensure_secret_container "$secret"
  secret_has_version "$secret" && secret_exists=1 || true

  if [[ "$user_exists" == "1" && "$secret_exists" == "1" ]]; then
    return 0
  fi
  if [[ "$user_exists" != "$secret_exists" ]]; then
    fail "database user/secret drift for $user and $secret; rotate deliberately instead of guessing"
  fi

  local password dsn
  password="$(random_token)"
  gcloud sql users create "$user"     --instance "$CLOUD_SQL_INSTANCE_NAME"     --project "$PROJECT_ID"     --password="$password" >/dev/null
  dsn="$(make_dsn "$user" "$password")"
  add_secret_value "$secret" "$dsn"
  unset password dsn
}

ensure_db_user_and_secret "$DB_INGEST_USER" "$DB_INGRESS_SECRET"
ensure_db_user_and_secret "$DB_WORKER_USER" "$DB_WORKER_SECRET"
ensure_db_user_and_secret "$DB_MIGRATOR_USER" "$DB_MIGRATOR_SECRET"

ensure_secret_container "$RAW_KEY_SECRET"
if ! secret_has_version "$RAW_KEY_SECRET"; then
  raw_key="$(python3 - <<'PY'
import base64, secrets
print(base64.b64encode(secrets.token_bytes(32)).decode())
PY
)"
  add_secret_value "$RAW_KEY_SECRET" "$raw_key"
  unset raw_key
fi

ensure_secret_container "$PROVIDER_HMAC_SECRET"
ensure_secret_container "$WEBHOOK_SECRETS_SECRET"
provider_secret_ready=0
secret_has_version "$PROVIDER_HMAC_SECRET" && provider_secret_ready=1 || true
webhook_secret_ready=0
secret_has_version "$WEBHOOK_SECRETS_SECRET" && webhook_secret_ready=1 || true
if [[ "$provider_secret_ready" != "$webhook_secret_ready" ]]; then
  fail "provider/webhook HMAC secret drift; rotate both deliberately"
fi
if [[ "$provider_secret_ready" == "0" ]]; then
  provider_hmac="$(random_token)"
  add_secret_value "$PROVIDER_HMAC_SECRET" "$provider_hmac"
  webhook_json="$(python3 - "$WHATSAPP_TENANT_ID" "$WHATSAPP_PROVIDER_ID" "$provider_hmac" <<'PY'
import json, sys
tenant, provider, secret = sys.argv[1:]
print(json.dumps({f"{tenant}:{provider}": secret}, separators=(",", ":")))
PY
)"
  add_secret_value "$WEBHOOK_SECRETS_SECRET" "$webhook_json"
  unset provider_hmac webhook_json
fi

for sa in "$INGRESS_SA_EMAIL" "$WORKER_SA_EMAIL" "$MIGRATOR_SA_EMAIL" "$RESTORE_SA_EMAIL"; do
  ensure_project_role "$sa" roles/cloudsql.client
done

for pair in   "$DB_INGRESS_SECRET:$INGRESS_SA_EMAIL"   "$RAW_KEY_SECRET:$INGRESS_SA_EMAIL"   "$WEBHOOK_SECRETS_SECRET:$INGRESS_SA_EMAIL"   "$DB_WORKER_SECRET:$WORKER_SA_EMAIL"   "$AGROLOG_SHARED_SECRET_NAME:$WORKER_SA_EMAIL"   "$DB_MIGRATOR_SECRET:$MIGRATOR_SA_EMAIL"   "$DB_MIGRATOR_SECRET:$RESTORE_SA_EMAIL"; do
  secret="${pair%%:*}"
  principal="${pair#*:}"
  gcloud secrets describe "$secret" --project "$PROJECT_ID" >/dev/null 2>&1     || fail "required secret missing: $secret"
  gcloud secrets add-iam-policy-binding "$secret" --project "$PROJECT_ID"     --member="serviceAccount:${principal}"     --role=roles/secretmanager.secretAccessor --quiet >/dev/null
done

gcloud run services add-iam-policy-binding "$AGROLOG_SERVICE_NAME"   --region "$REGION" --project "$PROJECT_ID"   --member="serviceAccount:${WORKER_SA_EMAIL}"   --role=roles/run.invoker --quiet >/dev/null

ensure_project_role "$BUILD_SA_EMAIL" roles/logging.logWriter
gcloud artifacts repositories add-iam-policy-binding "$AR_REPOSITORY"   --location "$REGION" --project "$PROJECT_ID"   --member="serviceAccount:${BUILD_SA_EMAIL}"   --role=roles/artifactregistry.writer --quiet >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${BUILD_SOURCE_BUCKET}"   --member="serviceAccount:${BUILD_SA_EMAIL}"   --role=roles/storage.objectViewer --quiet >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${BUILD_SOURCE_BUCKET}"   --member="serviceAccount:${BUILD_SA_EMAIL}"   --role=roles/storage.bucketViewer --quiet >/dev/null

for role in   roles/serviceusage.serviceUsageConsumer   roles/cloudbuild.builds.editor   roles/run.developer   roles/cloudsql.viewer   roles/secretmanager.viewer; do
  ensure_project_role "$DEPLOYER_SA_EMAIL" "$role"
done
gcloud artifacts repositories add-iam-policy-binding "$AR_REPOSITORY"   --location "$REGION" --project "$PROJECT_ID"   --member="serviceAccount:${DEPLOYER_SA_EMAIL}"   --role=roles/artifactregistry.reader --quiet >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${BUILD_SOURCE_BUCKET}"   --member="serviceAccount:${DEPLOYER_SA_EMAIL}"   --role=roles/storage.objectUser --quiet >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${BUILD_SOURCE_BUCKET}"   --member="serviceAccount:${DEPLOYER_SA_EMAIL}"   --role=roles/storage.bucketViewer --quiet >/dev/null

for sa in "$BUILD_SA_EMAIL" "$INGRESS_SA_EMAIL" "$WORKER_SA_EMAIL" "$MIGRATOR_SA_EMAIL"; do
  gcloud iam service-accounts add-iam-policy-binding "$sa"     --project "$PROJECT_ID"     --member="serviceAccount:${DEPLOYER_SA_EMAIL}"     --role=roles/iam.serviceAccountUser --quiet >/dev/null
done

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
BUILD_SERVICE_AGENT="service-${PROJECT_NUMBER}@gcp-sa-cloudbuild.iam.gserviceaccount.com"
gcloud iam service-accounts add-iam-policy-binding "$BUILD_SA_EMAIL"   --project "$PROJECT_ID"   --member="serviceAccount:${BUILD_SERVICE_AGENT}"   --role=roles/iam.serviceAccountTokenCreator --quiet >/dev/null

for role in roles/cloudsql.admin roles/run.admin roles/serviceusage.serviceUsageConsumer roles/logging.viewer; do
  ensure_project_role "$RESTORE_SA_EMAIL" "$role"
done
gcloud iam service-accounts add-iam-policy-binding "$RESTORE_SA_EMAIL"   --project "$PROJECT_ID"   --member="serviceAccount:${RESTORE_SA_EMAIL}"   --role=roles/iam.serviceAccountUser --quiet >/dev/null

if ! gcloud iam workload-identity-pools describe "$POOL_ID"   --location=global --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "$POOL_ID"     --location=global --project "$PROJECT_ID" --display-name="GitHub Actions"
fi

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
WIF_MAPPING="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.ref=assertion.ref"
WIF_CONDITION="assertion.repository_id=='${REPO_NUMERIC_ID}' && assertion.repository_owner_id=='${OWNER_NUMERIC_ID}' && assertion.ref=='refs/heads/main'"

if ! gcloud iam workload-identity-pools providers describe "$PROVIDER_ID"   --workload-identity-pool="$POOL_ID" --location=global --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID"     --workload-identity-pool="$POOL_ID"     --location=global     --project "$PROJECT_ID"     --display-name="WhatsApp AI GitHub"     --issuer-uri="https://token.actions.githubusercontent.com"     --attribute-mapping="$WIF_MAPPING"     --attribute-condition="$WIF_CONDITION"
else
  gcloud iam workload-identity-pools providers update-oidc "$PROVIDER_ID"     --workload-identity-pool="$POOL_ID"     --location=global     --project "$PROJECT_ID"     --issuer-uri="https://token.actions.githubusercontent.com"     --attribute-mapping="$WIF_MAPPING"     --attribute-condition="$WIF_CONDITION"     --quiet >/dev/null
fi

PROVIDER_RESOURCE="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}"
PRINCIPAL="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repository_id/${REPO_NUMERIC_ID}"
gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER_SA_EMAIL"   --project "$PROJECT_ID"   --member="$PRINCIPAL"   --role=roles/iam.workloadIdentityUser --quiet >/dev/null
gcloud iam service-accounts add-iam-policy-binding "$RESTORE_SA_EMAIL"   --project "$PROJECT_ID"   --member="$PRINCIPAL"   --role=roles/iam.workloadIdentityUser --quiet >/dev/null

printf '%s' "$PROJECT_ID" | gh secret set GCP_PROJECT_ID --repo "$REPO"
printf '%s' "$PROVIDER_RESOURCE" | gh secret set GCP_WORKLOAD_IDENTITY_PROVIDER --repo "$REPO"
printf '%s' "$DEPLOYER_SA_EMAIL" | gh secret set GCP_SERVICE_ACCOUNT --repo "$REPO"
printf '%s' "$RESTORE_SA_EMAIL" | gh secret set GCP_RESTORE_SERVICE_ACCOUNT --repo "$REPO"
printf '%s' "$BUILD_SA_EMAIL" | gh secret set GCP_BUILD_SERVICE_ACCOUNT --repo "$REPO"
printf '%s' "$BUILD_SOURCE_BUCKET" | gh secret set GCP_BUILD_SOURCE_BUCKET --repo "$REPO"
printf '%s' "$WHATSAPP_TENANT_ID" | gh secret set WHATSAPP_WORKER_TENANT_ID --repo "$REPO"

for sa in "$DEPLOYER_SA_EMAIL" "$BUILD_SA_EMAIL" "$INGRESS_SA_EMAIL" "$WORKER_SA_EMAIL" "$MIGRATOR_SA_EMAIL" "$RESTORE_SA_EMAIL"; do
  keys="$(gcloud iam service-accounts keys list     --iam-account="$sa" --managed-by=user --project "$PROJECT_ID" --format='value(name)' 2>/dev/null || true)"
  [[ -z "$keys" ]] || fail "USER_MANAGED service-account key found for $sa"
done

echo "GCP_ADMIN_BOOTSTRAP_PASS"
echo "project=$PROJECT_ID"
echo "region=$REGION"
echo "cloud_sql=$CLOUD_SQL_INSTANCE_NAME ($CLOUD_SQL_AVAILABILITY_TYPE)"
echo "artifact_registry=$AR_REPOSITORY"
echo "build_bucket=gs://$BUILD_SOURCE_BUCKET"
echo "wif_repo_id=$REPO_NUMERIC_ID"
echo "runtime_secrets=Secret Manager only; values not displayed"
echo "provider_hmac_secret=$PROVIDER_HMAC_SECRET (value not displayed)"
