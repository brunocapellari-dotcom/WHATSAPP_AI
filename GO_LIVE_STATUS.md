# GO-LIVE STATUS — WhatsApp AI

Updated: 2026-10-07

| ID | Task | Priority | Status | Dependency | Acceptance | Test | Evidence | Commit | Blocker |
|---|---|---:|---|---|---|---|---|---|---|
| WA-001 | Signed provider-independent webhook | P0 | DONE | none | invalid signature and replay rejected | pytest | `app/security.py`, `tests/test_security.py` | main baseline | none |
| WA-002 | Encrypted raw preservation | P0 | DONE | PostgreSQL + Secret Manager | encrypted raw + hash + provenance retained | code/CI | `app/storage.py` | main baseline | restore not yet production-proven |
| WA-003 | Deterministic freight classification/extraction | P0 | DONE | none | no prompt/tool execution from message content | pytest | `tests/test_freight_pipeline.py` | main baseline | none |
| WA-004 | Quality gate for incomplete canonical events | P0 | DONE | none | incomplete offer/request remains raw-only | regression + CI | CI run 358 PASS | `3f642fbb` | none |
| WA-005 | UPDATE/CANCELLATION correlation | P0 | DONE | none | mutation links only by strong/unambiguous evidence | regression + CI | CI run 358 PASS | `3f642fbb` | none |
| WA-006 | Tenant-safe mutation lookup | P0 | DONE | none | candidate lookup cannot cross tenant | regression + CI | CI run 358 PASS | `3f642fbb` | none |
| WA-007 | PostgreSQL RLS | P0 | PARTIAL | production DB roles | RLS behavior proven in PostgreSQL; production roles still required | PostgreSQL integration + CI | CI run 358 PASS | `3f642fbb` | production DB not provisioned |
| WA-008 | Durable outbox | P0 | DONE | none | atomic claim, stale-claim recovery, bounded retry, DEAD state | regression + CI | CI run 358 PASS | `3f642fbb` | none |
| WA-009 | Signed AgroLog delivery | P0 | DONE | AgroLog endpoint | HTTPS allowlist + HMAC + idempotency key | pytest/CI | `app/integration.py` | main baseline | production endpoint unavailable |
| WA-010 | Authorized WhatsApp provider | P0 | BLOCKED | authorized account/session | real authorized event enters canonical webhook | live E2E | none | none | human authorization/pairing required |
| WA-011 | Attachment quarantine/malware scan | P0 | TODO | quarantine storage/scanner | no attachment parsed before validation and clean scan | security/E2E | none | none | none |
| WA-012 | Distributed rate limiting | P0 | TODO | edge/runtime | abuse protection survives multi-instance deployment | load/security | none | none | deployment target required |
| WA-013 | Production deploy | P0 | DOING | GCP identity/secrets | reproducible deploy + dependency-aware readiness smoke | unit/integration/live smoke | readiness/logging branch | pending | infrastructure provisioning still pending |
| WA-014 | Backup/restore | P0 | BLOCKED | production PostgreSQL | successful non-destructive restore drill | restore drill | none | none | production DB unavailable |
| WA-015 | Two-run E2E to AgroLog | P0 | BLOCKED | WA-010 + WA-013 + AgroLog live | two distinct authorized payloads reach AgroLog without code edits | live E2E | none | none | external authorization/deploy |

## Gate rule

GO-LIVE is not declared while any P0 item is TODO, DOING, REVIEW, TESTING or BLOCKED without an explicitly accepted production-safe mitigation.

## Current execution order

1. Close CI for dependency-aware readiness and structured observability.
2. Add attachment quarantine/scanner boundary before any media download.
3. Add reproducible GCP runtime/database deployment with least-privilege service identities.
4. Integrate the authorized provider adapter behind a private/internal boundary.
5. Execute backup/restore drill.
6. Run authorized E2E twice with different data and no code change between runs.
