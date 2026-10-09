#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-southamerica-east1}"
INGRESS_SERVICE_NAME="${INGRESS_SERVICE_NAME:-whatsapp-ai-ingress}"
WEBHOOK_DOMAIN="${WEBHOOK_DOMAIN:-}"
EDGE_PREFIX="${EDGE_PREFIX:-whatsapp-ai-edge}"
BACKEND_NAME="${BACKEND_NAME:-${EDGE_PREFIX}-backend}"
ARMOR_POLICY="${ARMOR_POLICY:-${EDGE_PREFIX}-armor}"
SSL_CERT_NAME="${SSL_CERT_NAME:-${EDGE_PREFIX}-cert}"

fail() {
  echo "EDGE_VALIDATE_FAIL: $*" >&2
  exit 2
}

[[ -n "$PROJECT_ID" ]] || fail "PROJECT_ID is required"
[[ -n "$WEBHOOK_DOMAIN" ]] || fail "WEBHOOK_DOMAIN is required"

ingress_mode="$(gcloud run services describe "$INGRESS_SERVICE_NAME"   --region "$REGION" --project "$PROJECT_ID"   --format='value(metadata.annotations."run.googleapis.com/ingress")')"
[[ "$ingress_mode" == "internal-and-cloud-load-balancing" ]]   || fail "Cloud Run ingress is not load-balancer-only"

default_url_disabled="$(gcloud run services describe "$INGRESS_SERVICE_NAME"   --region "$REGION" --project "$PROJECT_ID"   --format='value(metadata.annotations."run.googleapis.com/default-url-disabled")')"
[[ "$default_url_disabled" == "true" ]]   || fail "Cloud Run default URL is still enabled"

attached_policy="$(gcloud compute backend-services describe "$BACKEND_NAME"   --global --project "$PROJECT_ID"   --format='value(securityPolicy)')"
[[ "$attached_policy" == *"/$ARMOR_POLICY" ]]   || fail "Cloud Armor policy is not attached to webhook backend"

rate_action="$(gcloud compute security-policies rules describe 1000   --security-policy="$ARMOR_POLICY" --project "$PROJECT_ID"   --format='value(action)')"
[[ "$rate_action" == "throttle" ]]   || fail "rate-limit rule priority 1000 is not throttle"

default_action="$(gcloud compute security-policies rules describe 2147483647   --security-policy="$ARMOR_POLICY" --project "$PROJECT_ID"   --format='value(action)')"
[[ "$default_action" == "deny(404)" || "$default_action" == "deny-404" ]]   || fail "Cloud Armor default rule is not deny-404"

cert_status="$(gcloud compute ssl-certificates describe "$SSL_CERT_NAME"   --project "$PROJECT_ID" --format='value(managed.status)')"
[[ "$cert_status" == "ACTIVE" ]]   || fail "managed certificate is not ACTIVE (DNS may still be pending)"

health_code="$(curl --proto '=https' --tlsv1.2 -sS -o /dev/null   -w '%{http_code}' --max-time 15 "https://${WEBHOOK_DOMAIN}/healthz")"
[[ "$health_code" == "404" ]]   || fail "non-webhook path was not blocked by Cloud Armor (status=$health_code)"

webhook_code="$(curl --proto '=https' --tlsv1.2 -sS -o /dev/null   -w '%{http_code}' --max-time 15   -X POST   -H 'content-type: application/json'   -H 'x-tenant-id: edge-probe'   "https://${WEBHOOK_DOMAIN}/v1/providers/edge-probe/events"   --data '{}')"
[[ "$webhook_code" == "401" ]]   || fail "webhook edge did not reach application signature gate (status=$webhook_code)"

echo "EDGE_VALIDATE_PASS"
echo "domain=$WEBHOOK_DOMAIN"
echo "cloud_armor=ACTIVE"
echo "default_path=DENY"
echo "unsigned_webhook=REJECTED"
