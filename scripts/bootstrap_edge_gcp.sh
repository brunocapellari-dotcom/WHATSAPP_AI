#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-southamerica-east1}"
INGRESS_SERVICE_NAME="${INGRESS_SERVICE_NAME:-whatsapp-ai-ingress}"
WEBHOOK_DOMAIN="${WEBHOOK_DOMAIN:-}"
ALLOW_BILLABLE_EDGE="${ALLOW_BILLABLE_EDGE:-0}"
RATE_LIMIT_PER_MINUTE="${WEBHOOK_RATE_LIMIT_PER_MINUTE:-600}"

EDGE_PREFIX="${EDGE_PREFIX:-whatsapp-ai-edge}"
NEG_NAME="${NEG_NAME:-${EDGE_PREFIX}-neg}"
BACKEND_NAME="${BACKEND_NAME:-${EDGE_PREFIX}-backend}"
ARMOR_POLICY="${ARMOR_POLICY:-${EDGE_PREFIX}-armor}"
URL_MAP_NAME="${URL_MAP_NAME:-${EDGE_PREFIX}-url-map}"
SSL_CERT_NAME="${SSL_CERT_NAME:-${EDGE_PREFIX}-cert}"
HTTPS_PROXY_NAME="${HTTPS_PROXY_NAME:-${EDGE_PREFIX}-https-proxy}"
IP_NAME="${IP_NAME:-${EDGE_PREFIX}-ip}"
FORWARDING_RULE_NAME="${FORWARDING_RULE_NAME:-${EDGE_PREFIX}-https-rule}"

fail() {
  echo "EDGE_BOOTSTRAP_FAIL: $*" >&2
  exit 2
}

[[ "$ALLOW_BILLABLE_EDGE" == "1" ]] || fail "set ALLOW_BILLABLE_EDGE=1 only after OWNER accepts Load Balancer/Cloud Armor cost"
[[ -n "$PROJECT_ID" ]] || fail "PROJECT_ID is required"
[[ -n "$WEBHOOK_DOMAIN" ]] || fail "WEBHOOK_DOMAIN is required"
[[ "$WEBHOOK_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || fail "WEBHOOK_DOMAIN has invalid characters"
[[ "$RATE_LIMIT_PER_MINUTE" =~ ^[0-9]+$ ]] || fail "WEBHOOK_RATE_LIMIT_PER_MINUTE must be numeric"
[[ "$RATE_LIMIT_PER_MINUTE" -ge 60 && "$RATE_LIMIT_PER_MINUTE" -le 10000 ]] || fail "rate limit must be between 60 and 10000 requests/minute"

for cmd in gcloud python3; do
  command -v "$cmd" >/dev/null 2>&1 || fail "$cmd is not installed"
done

gcloud config set project "$PROJECT_ID" >/dev/null

gcloud run services describe "$INGRESS_SERVICE_NAME" --region "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1   || fail "Cloud Run ingress service must exist before edge bootstrap"

gcloud run services update "$INGRESS_SERVICE_NAME"   --region "$REGION"   --project "$PROJECT_ID"   --ingress internal-and-cloud-load-balancing   --no-default-url   --no-invoker-iam-check   --quiet >/dev/null

if ! gcloud compute network-endpoint-groups describe "$NEG_NAME" --region "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud compute network-endpoint-groups create "$NEG_NAME"     --region "$REGION"     --project "$PROJECT_ID"     --network-endpoint-type=serverless     --cloud-run-service="$INGRESS_SERVICE_NAME"
fi

if ! gcloud compute backend-services describe "$BACKEND_NAME" --global --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud compute backend-services create "$BACKEND_NAME"     --project "$PROJECT_ID"     --load-balancing-scheme=EXTERNAL_MANAGED     --global
  gcloud compute backend-services add-backend "$BACKEND_NAME"     --project "$PROJECT_ID"     --global     --network-endpoint-group="$NEG_NAME"     --network-endpoint-group-region="$REGION"
fi

if ! gcloud compute security-policies describe "$ARMOR_POLICY" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud compute security-policies create "$ARMOR_POLICY"     --project "$PROJECT_ID"     --description="WhatsApp AI webhook edge: only signed application path is exposed"
fi

WEBHOOK_EXPR="request.method == 'POST' && request.path.matches('^/v1/providers/[A-Za-z0-9._-]+/events$')"

if gcloud compute security-policies rules describe 1000 --security-policy="$ARMOR_POLICY" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud compute security-policies rules update 1000     --project "$PROJECT_ID"     --security-policy="$ARMOR_POLICY"     --expression="$WEBHOOK_EXPR"     --action=throttle     --rate-limit-threshold-count="$RATE_LIMIT_PER_MINUTE"     --rate-limit-threshold-interval-sec=60     --conform-action=allow     --exceed-action=deny-429     --enforce-on-key=IP
else
  gcloud compute security-policies rules create 1000     --project "$PROJECT_ID"     --security-policy="$ARMOR_POLICY"     --expression="$WEBHOOK_EXPR"     --action=throttle     --rate-limit-threshold-count="$RATE_LIMIT_PER_MINUTE"     --rate-limit-threshold-interval-sec=60     --conform-action=allow     --exceed-action=deny-429     --enforce-on-key=IP
fi

gcloud compute security-policies rules update 2147483647   --project "$PROJECT_ID"   --security-policy="$ARMOR_POLICY"   --action=deny-404   --src-ip-ranges="*"

gcloud compute backend-services update "$BACKEND_NAME"   --project "$PROJECT_ID"   --global   --security-policy="$ARMOR_POLICY"

if ! gcloud compute url-maps describe "$URL_MAP_NAME" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud compute url-maps create "$URL_MAP_NAME"     --project "$PROJECT_ID"     --default-service="$BACKEND_NAME"
fi

if ! gcloud compute addresses describe "$IP_NAME" --global --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud compute addresses create "$IP_NAME"     --project "$PROJECT_ID"     --network-tier=PREMIUM     --ip-version=IPV4     --global
fi

if ! gcloud compute ssl-certificates describe "$SSL_CERT_NAME" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud compute ssl-certificates create "$SSL_CERT_NAME"     --project "$PROJECT_ID"     --domains="$WEBHOOK_DOMAIN"
fi

if ! gcloud compute target-https-proxies describe "$HTTPS_PROXY_NAME" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud compute target-https-proxies create "$HTTPS_PROXY_NAME"     --project "$PROJECT_ID"     --ssl-certificates="$SSL_CERT_NAME"     --url-map="$URL_MAP_NAME"
else
  gcloud compute target-https-proxies update "$HTTPS_PROXY_NAME"     --project "$PROJECT_ID"     --ssl-certificates="$SSL_CERT_NAME"     --url-map="$URL_MAP_NAME"
fi

if ! gcloud compute forwarding-rules describe "$FORWARDING_RULE_NAME" --global --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud compute forwarding-rules create "$FORWARDING_RULE_NAME"     --project "$PROJECT_ID"     --load-balancing-scheme=EXTERNAL_MANAGED     --network-tier=PREMIUM     --address="$IP_NAME"     --target-https-proxy="$HTTPS_PROXY_NAME"     --global     --ports=443
fi

EDGE_IP="$(gcloud compute addresses describe "$IP_NAME" --global --project "$PROJECT_ID" --format='value(address)')"
[[ -n "$EDGE_IP" ]] || fail "global edge IP was not allocated"

echo "EDGE_BOOTSTRAP_CONFIGURED"
echo "domain=$WEBHOOK_DOMAIN"
echo "edge_ip=$EDGE_IP"
echo "rate_limit_per_ip_per_minute=$RATE_LIMIT_PER_MINUTE"
echo "NEXT_HUMAN_ACTION: create/update DNS A record $WEBHOOK_DOMAIN -> $EDGE_IP"
echo "Do not share webhook HMAC secrets in chat or DNS."
echo "After DNS propagates, run scripts/validate_edge_gcp.sh."
