# Release Acceptance Matrix

A release is `PASS` only when every mandatory scenario below passes. “100%” refers to this matrix.

| Domain | Mandatory scenarios |
|---|---|
| Ingestion | valid webhook; invalid signature; replay/duplicate; provider unavailable; malformed payload; collector disabled |
| Freight | relevant/irrelevant; extraction; field truth class; entity aliases; same offer across groups; small text variation; quality issues; tenant isolation |
| Business | normal, rushed, irritated, indecisive, confused, discount, restricted info, prompt injection, nonexistent product/price, complex order; tool success/failure; handoff |
| Multimodal | text, audio, image, PDF, spreadsheet, DOCX; MIME spoof; oversized file; malware; parser failure |
| Security | prompt/tool injection, SSRF private host, HMAC mismatch, replay, tenant crossing, financial action without approval, malicious attachment |
| Resilience | DB transient failure, provider transient failure, LLM failure, AgroLog failure, retry/backoff, stale outbox lock recovery, restart during pending work |
| AgroLog | observation event, logical freight event, idempotency key, retry, no direct analytical DB write |
| Ops | migrations from empty DB, build, container build, metrics endpoint, audit log, backup restore rehearsal |

## Automated today

The repository contains automated suites for Freight E2E, Business E2E, Test Lab personas, media fail-closed behavior, Meta normalization, entity/dedup core, golden extraction corpus, webhook/policy/SSRF/attachment security and PostgreSQL RLS.

## Requires staging credentials/infrastructure

Real Meta webhook/send/media, optional WPPConnect group flow, OpenAI transcription/vision/file parsing, ClamAV daemon integration, AgroLog Gateway contract, network egress rules and backup/restore are release-gated staging tests and must never be marked passed from mocks alone.
