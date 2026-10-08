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
INGRESS_SERVICE_NAME="${INGRESS_SERVICE_NAME:-whatsapp-ai-ingress}"
WORKER_JOB_NAME="${WORKER_JOB_NAME:-whatsapp-ai-outbox}"
MIGRATION_JOB_NAME="${MIGRATION_JOB_NAME:-whatsapp-ai-migrate}"
AGROLOG_SERVICE_NAME="${AGROLOG_SERVICE_NAME:-agrolog-freight-ingest}"
WHATSAPP_WORKER_TENANT_ID="${WHATSAPP_WORKER_TENANT_ID:-}"
DB_INGEST_ROLE="${DB_INGEST_ROLE:-whatsapp_ingest_app}"
DB_WORKER_ROLE="${DB_WORKER_ROLE:-whatsapp_worker_app}"
DB_INGRESS_SECRET="${DB_INGRESS_SECRET:-whatsapp-ai-database-url}"
DB_WORKER_SECRET="${DB_WORKER_SECRET:-whatsapp-ai-database-url-worker}"
DB_MIGRATOR_SECRET="${DB_MIGRATOR_SECRET:-whatsapp-ai-database-url-migrator}"
RAW_KEY_SECRET="${RAW_KEY_SECRET:-whatsapp-ai-raw-encryption-key}"
WEBHOOK_SECRETS_SECRET="${WEBHOOK_SECRETS_SECRET:-whatsapp-ai-webhook-secrets}"
AGROLOG_SHARED_SECRET_NAME="${AGROLOG_SHARED_SECRET_NAME:-agrolog-freight-shared-secret}"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short=12 HEAD 2>/dev/null || date +%Y%m%d%H%M%S)}"
MAX_INSTANCES="${WHATSAPP_MAX_INSTANCES:-3}"
CONCURRENCY="${WHATSAPP_CONCURRENCY:-20}"
CPU="${WHATSAPP_CPU:-1}"
MEMORY="${WHATSAPP_MEMORY:-512Mi}"

bash scripts/preflight_gcp.sh

connection_name="$(gcloud sql instances describe "$CLOUD_SQL_INSTANCE_NAME"   --project "$PROJECT_ID" --format='value(connectionName)')"
agrolog_url="$(gcloud run services describe "$AGROLOG_SERVICE_NAME"   --region "$REGION" --project "$PROJECT_ID" --format='value(status.url)')"
agrolog_host="$(python3 - "$agrolog_url" <<'PY'
import sys
from urllib.parse import urlparse
parsed = urlparse(sys.argv[1])
if parsed.scheme != "https" or not parsed.hostname:
    raise SystemExit("invalid AgroLog service URL")
print(parsed.hostname)
PY
)"

ingress_sa="${INGRESS_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
worker_sa="${WORKER_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
migrator_sa="${MIGRATOR_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
image="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPOSITORY}/whatsapp-ai:${IMAGE_TAG}"

previous_revision="$(gcloud run services describe "$INGRESS_SERVICE_NAME"   --region "$REGION" --project "$PROJECT_ID"   --format='value(status.latestReadyRevisionName)' 2>/dev/null || true)"
migration_job_created=0

rollback() {
  local code=$?
  if [[ "$code" -ne 0 ]]; then
    echo "DEPLOY_FAIL code=$code" >&2
    if [[ -n "$previous_revision" ]]; then
      echo "Rolling traffic back to previous revision: $previous_revision" >&2
      gcloud run services update-traffic "$INGRESS_SERVICE_NAME"         --region "$REGION" --project "$PROJECT_ID"         --to-revisions="${previous_revision}=100" --quiet >/dev/null 2>&1 || true
    fi
  fi
  if [[ "$migration_job_created" == "1" ]]; then
    gcloud run jobs delete "$MIGRATION_JOB_NAME"       --region "$REGION" --project "$PROJECT_ID" --quiet >/dev/null 2>&1 || true
  fi
  exit "$code"
}
trap rollback EXIT

echo "Building image $image"
gcloud builds submit .   --project "$PROJECT_ID"   --service-account "$BUILD_SERVICE_ACCOUNT"   --gcs-source-staging-dir "gs://${BUILD_SOURCE_BUCKET}/source"   --tag "$image"

echo "Applying checksum-verified migrations with temporary job"
gcloud run jobs deploy "$MIGRATION_JOB_NAME"   --image "$image"   --region "$REGION"   --project "$PROJECT_ID"   --service-account "$migrator_sa"   --set-cloudsql-instances "$connection_name"   --update-secrets "DATABASE_URL_MIGRATOR=${DB_MIGRATOR_SECRET}:latest"   --set-env-vars "WHATSAPP_DB_INGEST_ROLE=${DB_INGEST_ROLE},WHATSAPP_DB_WORKER_ROLE=${DB_WORKER_ROLE}"   --command python   --args scripts/release_migrate.py   --max-retries 0   --task-timeout 10m   --quiet
migration_job_created=1

gcloud run jobs execute "$MIGRATION_JOB_NAME"   --region "$REGION" --project "$PROJECT_ID" --wait
gcloud run jobs delete "$MIGRATION_JOB_NAME"   --region "$REGION" --project "$PROJECT_ID" --quiet
migration_job_created=0

echo "Deploying private ingress service"
gcloud run deploy "$INGRESS_SERVICE_NAME"   --image "$image"   --region "$REGION"   --project "$PROJECT_ID"   --service-account "$ingress_sa"   --execution-environment gen2   --cpu "$CPU"   --memory "$MEMORY"   --max-instances "$MAX_INSTANCES"   --concurrency "$CONCURRENCY"   --timeout 30s   --ingress all   --no-allow-unauthenticated   --add-cloudsql-instances "$connection_name"   --set-env-vars "ENABLE_DOCS=0,WHATSAPP_MAX_WEBHOOK_BYTES=1000000"   --update-secrets "DATABASE_URL=${DB_INGRESS_SECRET}:latest,WHATSAPP_RAW_ENCRYPTION_KEY_B64=${RAW_KEY_SECRET}:latest,WHATSAPP_WEBHOOK_SECRETS=${WEBHOOK_SECRETS_SECRET}:latest"   --startup-probe "httpGet.path=/readyz,httpGet.port=8080,initialDelaySeconds=1,failureThreshold=10,timeoutSeconds=3,periodSeconds=3"   --readiness-probe "httpGet.path=/readyz,httpGet.port=8080,successThreshold=1,failureThreshold=3,timeoutSeconds=3,periodSeconds=5"   --liveness-probe "httpGet.path=/healthz,httpGet.port=8080,initialDelaySeconds=5,failureThreshold=3,timeoutSeconds=3,periodSeconds=10"   --quiet

echo "Deploying tenant-scoped outbox worker job"
gcloud run jobs deploy "$WORKER_JOB_NAME"   --image "$image"   --region "$REGION"   --project "$PROJECT_ID"   --service-account "$worker_sa"   --set-cloudsql-instances "$connection_name"   --update-secrets "DATABASE_URL_WORKER=${DB_WORKER_SECRET}:latest,AGROLOG_SHARED_SECRET=${AGROLOG_SHARED_SECRET_NAME}:latest"   --set-env-vars "^@^WHATSAPP_WORKER_TENANT_ID=${WHATSAPP_WORKER_TENANT_ID}@AGROLOG_FREIGHT_INGEST_URL=${agrolog_url}/v1/freight/events@AGROLOG_OIDC_AUDIENCE=${agrolog_url}@AGROLOG_EGRESS_ALLOWED_HOSTS=${agrolog_host}@OUTBOX_MAX_ATTEMPTS=8@OUTBOX_CLAIM_TIMEOUT_SECONDS=300"   --command python   --args=-m,app.worker   --max-retries 0   --task-timeout 5m   --quiet

echo "Running worker smoke execution"
gcloud run jobs execute "$WORKER_JOB_NAME"   --region "$REGION" --project "$PROJECT_ID" --wait

service_json="$(mktemp)"
trap 'rm -f "$service_json"' RETURN
gcloud run services describe "$INGRESS_SERVICE_NAME"   --region "$REGION" --project "$PROJECT_ID" --format=json >"$service_json"
python3 - "$service_json" "$ingress_sa" <<'PY'
import json
import sys

path, expected_sa = sys.argv[1:]
service = json.load(open(path, encoding="utf-8"))
template = service.get("spec", {}).get("template", {}).get("spec", {})
actual_sa = template.get("serviceAccountName")
if actual_sa != expected_sa:
    raise SystemExit(f"unexpected ingress runtime identity: {actual_sa!r}")
status = service.get("status", {})
conditions = {item.get("type"): item.get("status") for item in status.get("conditions", [])}
if conditions.get("Ready") != "True":
    raise SystemExit(f"ingress service not Ready: {conditions}")
created = status.get("latestCreatedRevisionName")
ready = status.get("latestReadyRevisionName")
if not ready or ready != created:
    raise SystemExit(f"latest ingress revision not ready: created={created!r} ready={ready!r}")
print(f"INGRESS_READY revision={ready}")
PY
rm -f "$service_json"

broad_binding="$(gcloud run services get-iam-policy "$INGRESS_SERVICE_NAME"   --region "$REGION" --project "$PROJECT_ID"   --flatten='bindings[].members'   --filter='bindings.role=roles/run.invoker AND (bindings.members=allUsers OR bindings.members=allAuthenticatedUsers)'   --format='value(bindings.members)' | head -n1)"
if [[ "$broad_binding" == "allUsers" || "$broad_binding" == "allAuthenticatedUsers" ]]; then
  echo "DEPLOY_FAIL: ingress service has broad public invoker binding" >&2
  exit 4
fi

trap - EXIT
echo "WHATSAPP_AI_DEPLOY_PASS"
echo "image=$image"
echo "ingress_service=$INGRESS_SERVICE_NAME"
echo "worker_job=$WORKER_JOB_NAME"
echo "agrolog_target=$AGROLOG_SERVICE_NAME"
echo "runtime_secrets=Secret Manager references only"
