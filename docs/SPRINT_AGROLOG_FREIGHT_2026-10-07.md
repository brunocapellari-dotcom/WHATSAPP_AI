# Sprint AgroLog Freight — 2026-10-07

## Mission

This branch implements the executable provider-independent core for:

AUTHORIZED WHATSAPP -> RAW EVENT -> CLASSIFICATION -> EXTRACTION -> NORMALIZATION -> ENTITY RESOLUTION -> DEDUPLICATION -> CANONICAL FREIGHT EVENT -> TRANSACTIONAL OUTBOX -> AGROLOG.

## Evidence-based status

| Capability | Status | Evidence |
|---|---|---|
| provider-independent canonical webhook | FUNCTIONAL in code | `app/main.py` |
| HMAC signature validation | FUNCTIONAL in code/tests | `app/security.py`, `tests/test_security.py` |
| replay window | FUNCTIONAL in code/tests | timestamp signature gate |
| raw preservation | FUNCTIONAL in code | encrypted PostgreSQL raw vault |
| idempotency by provider event id | FUNCTIONAL in code/tests | processed-event primary key |
| deterministic classification/extraction | FUNCTIONAL in code/tests | `app/parser.py` |
| normalization/entity envelope | FUNCTIONAL baseline | resolver preserves raw/normalized/canonical/confidence |
| logical dedup/repost | FUNCTIONAL baseline | `app/pipeline.py` |
| rate-change versioning | FUNCTIONAL in tests | same logical event, incremented version |
| AgroLog transactional outbox | FUNCTIONAL producer | PostgreSQL outbox |
| AgroLog HTTP client | FUNCTIONAL client | signed HTTPS + egress allowlist |
| image/PDF OCR/parser | PARTIAL | metadata preserved; OCR is intentionally not fabricated |
| malware scanning | ABSENT runtime hook | production blocker for attachment download/processing |
| RBAC | PARTIAL | tenant/provider secret boundary exists; user/business RBAC not needed on ingestion endpoint |
| tenant isolation | PARTIAL | tenant included in all keys; PostgreSQL RLS migration still required |
| distributed rate limiting | ABSENT | must be enforced at edge/API gateway or shared limiter |
| provider-specific authorized connector | BLOCKED EXTERNALLY | requires approved provider/account method |
| production E2E into AgroLog | BLOCKED EXTERNALLY | requires deployed AgroLog endpoint, shared secret and infrastructure |

## Required production secrets

- `DATABASE_URL`
- `WHATSAPP_RAW_ENCRYPTION_KEY_B64` (Secret Manager supplied)
- `WHATSAPP_WEBHOOK_SECRETS` (Secret Manager supplied mapping)
- `AGROLOG_FREIGHT_INGEST_URL`
- `AGROLOG_SHARED_SECRET`
- `AGROLOG_EGRESS_ALLOWED_HOSTS`

No real secret belongs in Git.

## Security boundary

WhatsApp payloads are untrusted data. The freight parser is deterministic and does not execute message content, tool calls, shell commands, URLs or prompt instructions. Attachment bytes are not fetched by this service. Any future media processor must validate observed MIME, scan malware in isolation, enforce size/decompression limits and retain quarantine provenance before parsing.

## Remaining release gates

1. add PostgreSQL RLS migration and tenant session enforcement;
2. implement attachment quarantine + malware scanner worker before downloading media;
3. implement authorized provider adapter and run FL-0 against a real authorized test account;
4. add AgroLog receiver endpoint/table contract and run signed integration twice with different fixtures;
5. run CI on exact PR head and preserve workflow evidence;
6. deploy and run backup/restore + audit-log verification.
