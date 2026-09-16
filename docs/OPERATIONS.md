# Operations

## Deployment sequence

1. Provision managed PostgreSQL and secrets.
2. Run migrations using the migration identity; application and privileged worker identities must remain separate in production. RLS is forced on tenant tables.
3. Provision ClamAV or approved malware-scanning service.
4. Configure Meta and, only if approved, WPPConnect provider secrets.
5. Configure OpenAI and AgroLog Gateway credentials.
6. Start API and worker separately.
7. Register tenant/collectors with `npm run bootstrap -- ...`.
8. Verify live/ready/metrics and run the complete staging acceptance matrix.

## Failure behavior

- invalid or malicious inbound: reject before governed processing;
- duplicate message: idempotent discard;
- attachment scanner/parser failure: fail closed;
- LLM unavailable in Business AI: handoff rather than inventing an answer;
- AgroLog unavailable: outbox remains pending with exponential retry and stale-lock recovery;
- provider unavailable: readiness degrades and sender operation fails visibly;
- maintenance job failure: pg-boss retries with backoff and routes exhausted quarantine-purge jobs to a dedicated DLQ.

## Data retention

Inbound source payloads are stored only in encrypted quarantine and receive an `expires_at` timestamp. The privileged worker schedules a `quarantine-purge` maintenance job at most once every 15 minutes and deletes every row whose expiry has passed, regardless of final disposition. A dedicated index covers `expires_at` for all dispositions.

The 24-hour quarantine interval used by ingestion is a technical default, not a legal retention determination. Production must define retention for governed raw/domain/audit data according to purpose, applicable obligations and approved policy. Increasing quarantine retention requires an explicit policy decision rather than a code-only change.

## Release discipline

A release candidate is promoted only when the complete Acceptance Matrix passes on the same commit. If any code, dependency, migration, provider, security policy or workflow changes after a gate run, the whole gate is invalidated and must run again from zero.
