# GO-LIVE STATUS — WhatsApp AI

Updated: 2026-10-08

| ID | Task | Priority | Status | Dependency | Acceptance | Test | Evidence | Commit | Blocker |
|---|---|---:|---|---|---|---|---|---|---|
| WA-001 | Signed provider-independent webhook | P0 | DONE | none | invalid signature/replay rejected; identifiers validated | pytest + CI | security regression | main | none |
| WA-002 | Encrypted RAW preservation | P0 | DONE | PostgreSQL + secret | AES-GCM RAW + hash + provenance | PostgreSQL integration + CI | CI green | main | none |
| WA-003 | Freight classification/extraction | P0 | DONE | none | deterministic parser; untrusted text cannot execute tools | pytest + CI | freight regression | main | none |
| WA-004 | Quality gate for incomplete events | P0 | DONE | none | incomplete offer/request stays RAW-only | pytest + CI | CI green | main | none |
| WA-005 | UPDATE/CANCELLATION correlation | P0 | DONE | none | only strong/unambiguous linkage mutates prior event | pytest + CI | mutation regression | main | none |
| WA-006 | Tenant isolation + PostgreSQL RLS | P0 | BLOCKED | production DB provisioning | app + RLS integration proven; production roles must be materialized | PostgreSQL integration + CI | RLS CI green | main | Cloud SQL not provisioned |
| WA-007 | Durable tenant-scoped AgroLog outbox | P0 | DONE | none | atomic claim, stale recovery, bounded retry, DEAD, tenant scope | integration + CI | CI green | `ec2a3936` | none |
| WA-008 | Private AgroLog delivery | P0 | DONE | AgroLog freight service | OIDC/IAM + HMAC + idempotency + host/path allowlist | pytest + CI | private integration tests | `8d30bd50` | production execution pending |
| WA-009 | Public webhook edge architecture | P0 | READY | GCP + domain | only external HTTPS LB reaches service; run.app disabled | deploy contract + CI | Cloud Armor/LB scripts green | `c25c6f46` | billable edge not provisioned |
| WA-010 | Distributed rate limiting/default deny | P0 | READY | WA-009 | Cloud Armor per-IP throttle; non-webhook path denied | security contract + CI | edge validation scripts green | `c25c6f46` | billable edge not provisioned |
| WA-011 | GCP production bootstrap | P0 | READY | OWNER cost/capacity inputs | idempotent Cloud SQL/WIF/IAM/Secret Manager bootstrap | static/security + CI | bootstrap contract green | `dde805a9` | explicit billable sizing decision |
| WA-012 | Attachment byte safety | P0 | DONE | none | v1 rejects every storage/byte reference before parsing | pytest + CI | metadata-only boundary green | `1a36412f` | media-byte/OCR deferred post-go-live |
| WA-013 | Reproducible production deploy | P0 | BLOCKED | WA-011 + WA-009 | build→migrate→deploy→smoke→rollback succeeds | manual prod gate | code/CI ready | `8d30bd50` | production infrastructure absent |
| WA-014 | Non-destructive backup/restore drill | P0 | BLOCKED | production Cloud SQL | new-instance restore validates migration checksums, required tables and FORCE RLS; temp instance deleted | manual DR gate | drill code/CI green | `23dd306a` | production DB absent + billable drill confirmation |
| WA-015 | Hardened WPPConnect provider bridge | P0 | TESTING | CI | allowlisted onmessage→encrypted local outbox→signed cloud webhook; no media bytes | unit/security/supply-chain | PR #13 | branch | CI pending |
| WA-016 | Authorized WhatsApp session | P0 | BLOCKED | WA-015 + authorized number | local QR pairing and stable reconnect without exposing token/QR | live provider test | pairing automation ready | branch | human QR scan/authorization |
| WA-017 | Two-run live E2E to AgroLog | P0 | BLOCKED | WA-009/011/013/016 | two different real freight messages reach AgroLog without code edits | live E2E | none | none | production + pairing |

## Gate rule

GO-LIVE is not declared while any P0 task is unresolved without an accepted production-safe mitigation.

## Current execution order

1. Close PR #13 provider bridge with full CI/supply-chain gate.
2. Provision the approved GCP baseline and edge only after explicit billable inputs.
3. Pair one dedicated, authorized WhatsApp account locally; QR/token never leave the host.
4. Deploy and run dependency-aware smoke tests.
5. Execute non-destructive backup/restore drill.
6. Execute the real WhatsApp→bridge→edge→WhatsApp AI→AgroLog flow twice with different freight messages and no code change between runs.
