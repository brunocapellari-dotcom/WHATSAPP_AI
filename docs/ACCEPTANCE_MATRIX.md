# Release Acceptance Matrix

A release is `PASS` only when every mandatory scenario below passes on the same commit.

| Domain | Mandatory scenarios |
|---|---|
| Cost invariant | zero-cost default; external AI/transcription/AgroLog blocked; Meta send blocked; no hosted runner dependency |
| Ingestion | valid auth; invalid signature; replay; malformed payload; collector disabled; durable inbox outage/recovery |
| WPP reconciliation | all-new + all-unread merge; dedupe; persist-before-seen; provider outage; reconnect; authorized group |
| Freight | relevant/irrelevant; single relevance decision; extraction; truth class; aliases; repost across groups; variation; quality; tenant isolation; OBSERVED_OFFER scope; monotonic revision history |
| Canonical entities | IBGE city; ANTT latest-resource discovery; RNTRC pagination; active organization import; personal/TAC exclusion; stale cleanup only after complete snapshot; global read; global tenant-write denial; company import contract; textual external ids; exact alias; conservative pg_trgm typo; short-alias exact-only; ambiguous fuzzy rejection; company/carrier/facility namespace separation; match method/confidence provenance |
| Business | normal; rushed; irritated; indecisive; confused; discount; restricted info; prompt injection; nonexistent data; complex request |
| Tools | schema supplied to model; validation; real output synthesis; tool failure; unknown tool; no invented fields |
| Human handoff | persist handoff; AI suspended while WAITING_HUMAN/HUMAN; local operator token auth; forged/expired/revoked token denial; tenant isolation; role denial; claim conflict; release; resume AI; close |
| Operator outbound | owner-only; request-id idempotency; safe retry pre-delivery; no retry uncertain; status lookup |
| Approval | high-risk plan freezes auto tools; request idempotency; supervisor/admin-only visibility and decision; approve once; reject; second approval blocked; audit |
| Follow-up | conversation-bound schedule; due delivery; safe retry; ambiguous delivery -> human; stale SENDING recovery |
| Multimodal | text; audio; image; PDF text; scanned PDF; XLSX; DOCX; MIME spoof; oversize; malware; ZIP bomb; parser timeout |
| Security | prompt/tool injection; SSRF; HMAC mismatch; tenant crossing; global-catalog write; malicious attachment; shell/eval SAST |
| Resilience | DB transient failure; provider transient failure; local AI failure; outbox failure; retries/backoff; stale locks; process restart |
| AgroLog | observation/event topics; transactional observation+event+outbox atomicity; revision-keyed event idempotency; local NDJSON fsync; replay safety; no direct analytical DB write |
| Ops | migrations empty DB; lint; typecheck; provider contract tests; JSON Schema export; all tests; build; read-only/no-new-privileges containers; ready/metrics; backup; restore rehearsal; compose validation |
| Supply chain | exact committed lockfile; approved remote dependency URL + lock integrity; npm audit; Semgrep; Gitleaks full history; Trivy fs/config/image; CycloneDX SBOM |

## Automated repository coverage

The repository contains unit, contract, security, integration and E2E suites for the deterministic portions above, including PostgreSQL RLS, transactional freight outbox rollback, freight revision semantics, provider contracts, delivery state machines, human handoff, approvals, operator messages, follow-ups, local AI contracts, WPP normalization/reconciliation, Office sandboxing, provenance minimization and AgroLog outbox.

## Requires local real-runtime validation

Mocks do not prove:

- an authorized WPPConnect WhatsApp session;
- reconnect behavior against the live service;
- actual WhatsApp group/media behavior;
- Ollama Qwen3-VL quality on the project's real corpus;
- whisper.cpp quality on real Portuguese audios;
- ClamAV daemon/signature lifecycle;
- host resource sufficiency;
- local firewall/backup storage;
- AgroLog's consumption of exported events.

These must pass before `OPERATIONAL`.

## Definition of 100%

“100% tested” means every mandatory scenario in this matrix is green on the same release candidate. It does not mean 100% line coverage.
