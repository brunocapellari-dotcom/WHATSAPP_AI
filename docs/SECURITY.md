# Security model

## Trust boundary

WhatsApp text, URL, audio, image, PDF, spreadsheet and documents are always untrusted data. Content can never modify system rules, permissions, model policy or tool authorization.

Inbound path:

```text
provider auth/reconciliation
→ durable inbox
→ normalization
→ encrypted quarantine
→ MIME/archive/malware validation
→ policy/relevance
→ governed storage/domain processing
```

## Controls

- Meta HMAC validation over raw bytes when Meta is enabled;
- WPP direct webhook disabled by default; optional endpoint requires HMAC signing proxy;
- WPP canonical path uses durable reconciliation before `send-seen`;
- replay/idempotency by provider message id, business run, request id and outbox key;
- PostgreSQL RLS + FORCE RLS and composite tenant foreign keys;
- global canonical catalog is read-only to tenant roles;
- AES-256-GCM for quarantined payload, routing data and approval inputs/results;
- HMAC pseudonymization of sender identifiers;
- exact tool schemas from Zod converted to JSON Schema for local-model planning;
- FINANCIAL/IRREVERSIBLE calls are persisted for human approval and never executed by agent authority;
- human handoff suspends AI until explicit `resume-ai`;
- operator bearer tokens are random local credentials stored only as SHA-256 hashes and bound to tenant/operator/role;
- operator requests never supply their own tenant/operator identity; authorization context comes from the bearer token;
- approval visibility/decision requires `SUPERVISOR` or `ADMIN`;
- manual operator messages require conversation ownership and idempotent `requestId`;
- MIME + magic-byte validation, size limits, ZIP expansion limits and ClamAV fail closed;
- XLSX/DOCX parser is isolated with CPU/time/memory boundary;
- SSRF resolver blocks loopback/private/link-local targets for untrusted URLs;
- no shell, SQL, filesystem or arbitrary network tools are exposed to the model;
- Semgrep CE offline, Gitleaks, Trivy and npm audit run in the local Release Gate;
- SBOM CycloneDX is generated for every release candidate;
- application containers run read-only with dropped Linux capabilities and `no-new-privileges`, with only bounded tmpfs/required volumes writable.

## Delivery ambiguity

For any WhatsApp outbound:

1. durable state is written before provider call;
2. definite pre-delivery failure may be retried;
3. ambiguous result becomes `DELIVERY_UNCERTAIN`;
4. stale `SENDING` never returns automatically to send;
5. human review is required.

This prevents “retry to see if it worked” duplicates.

## Database privilege separation

- API: tenant-scoped `DATABASE_URL`.
- Worker: separate `WORKER_DATABASE_URL` with narrowly scoped cross-tenant privileges.
- Migrations/global catalog imports: `MIGRATION_DATABASE_URL`.
- No runtime role should own schema in production.

## Zero-cost network boundary

When `ZERO_COST_MODE=true`, configuration rejects external/public endpoints for local AI, transcription and AgroLog gateway and rejects Meta sending credentials.

This is a billing guardrail and an egress-reduction control; it does not replace host firewall policy.

## Secrets

Secrets remain outside Git:
- `.env` is ignored and Compose requires explicit PostgreSQL/WPP secrets;
- release tests use an isolated temporary env instead of the operator's personal `.env`;
- WhatsApp sessions/tokens are mounted volumes/env only;
- no QR/session material is committed;
- backups and generated security artifacts are local and ignored where appropriate.

## Release rule

A candidate is not operational until the same commit passes the entire Acceptance Matrix, backup/restore rehearsal and security gate.
