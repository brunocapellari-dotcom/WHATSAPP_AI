# GO-LIVE STATUS — WhatsApp AI

Updated: 2026-10-08

| ID | Task | Priority | Status | Dependency | Acceptance | Test | Evidence | Commit | Blocker |
|---|---|---:|---|---|---|---|---|---|---|
| WA-001 | Signed provider-independent webhook | P0 | DONE | none | invalid signature and replay rejected | pytest | security regression | main | none |
| WA-002 | Encrypted raw preservation | P0 | DONE | PostgreSQL + Secret Manager | encrypted raw + hash + provenance retained | integration/CI | PostgreSQL tests | main | production restore not yet proven |
| WA-003 | Freight classification/extraction | P0 | DONE | none | deterministic parser; untrusted text cannot execute tools | pytest | freight regression | main | none |
| WA-004 | Quality gate for incomplete events | P0 | DONE | none | incomplete offer/request stays raw-only | pytest/CI | CI green | main | none |
| WA-005 | UPDATE/CANCELLATION correlation | P0 | DONE | none | only strong/unambiguous linkage mutates prior event | pytest/CI | CI green | main | none |
| WA-006 | Tenant isolation + PostgreSQL RLS | P0 | PARTIAL | production DB roles | app + RLS isolation proven; runtime roles still require production provisioning | PostgreSQL integration | CI green | main | production DB not provisioned |
| WA-007 | Durable tenant-scoped outbox | P0 | DONE | none | stale claim recovery, bounded retry, DEAD state, tenant-scoped worker | integration/CI | CI green | main | none |
| WA-008 | Private AgroLog delivery | P0 | DONE | AgroLog freight service | OIDC/IAM + HMAC + idempotency | pytest/CI | private integration tests | main | production endpoint deployment pending |
| WA-009 | Public webhook edge | P0 | TESTING | CI | only HTTPS LB path reaches webhook; run.app disabled | static/security + production validation | branch | branch | billable edge not provisioned |
| WA-010 | Distributed rate limiting | P0 | TESTING | WA-009 | Cloud Armor per-IP throttle + default deny | deploy contract + production validation | branch | branch | billable edge not provisioned |
| WA-011 | Authorized WhatsApp provider | P0 | BLOCKED | authorized account/session | two real authorized messages enter webhook | live E2E | none | none | human pairing/authorization |
| WA-012 | Attachment byte processing | P0 | READY | none | no media bytes parsed until quarantine+scan exists | code audit/security | current path is metadata-only | main | scanner needed only before enabling media-byte processing |
| WA-013 | Production deploy | P0 | BLOCKED | GCP resources/WIF/secrets | build→migrate→deploy→smoke→rollback path succeeds | manual production gate | deploy scripts + CI | main | infrastructure not provisioned |
| WA-014 | Backup/restore | P0 | BLOCKED | production PostgreSQL | restore drill succeeds | restore drill | none | none | production DB unavailable |
| WA-015 | Two-run E2E to AgroLog | P0 | BLOCKED | WA-011 + WA-013 | two distinct messages reach AgroLog without code changes | live E2E | none | none | provider + production deploy |

## Gate rule

GO-LIVE is not declared while any P0 task is unresolved without an accepted production-safe mitigation.

## Current execution order

1. Merge public-edge/rate-limit hardening after CI.
2. Keep attachment bytes disabled until quarantine + malware scan is implemented and tested.
3. Provision production GCP/WIF/Secret Manager/Cloud SQL with least privilege.
4. Pair one authorized WhatsApp account/provider session.
5. Run backup/restore.
6. Execute E2E twice with different freight messages and no code changes between runs.
