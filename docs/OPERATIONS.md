# Operations

## Deployment sequence

1. Provision managed PostgreSQL and secrets.
2. Run migrations using the same schema owner used by the runtime or a migration identity; RLS is forced on tenant tables.
3. Provision ClamAV or approved malware-scanning service.
4. Configure Meta and, only if approved, WPPConnect provider secrets.
5. Configure OpenAI and AgroLog Gateway credentials.
6. Start API and worker separately.
7. Register tenant/collectors with `npm run bootstrap -- ...`.
8. Verify live/ready/metrics and run staging acceptance matrix.

## Failure behavior

- invalid or malicious inbound: reject before governed processing;
- duplicate message: idempotent discard;
- attachment scanner/parser failure: fail closed;
- LLM unavailable in Business AI: handoff rather than inventing an answer;
- AgroLog unavailable: outbox remains pending with exponential retry and stale-lock recovery;
- provider unavailable: readiness degrades and sender operation fails visibly.

## Data retention

Quarantine defaults to 24 hours in ingestion. Production must also run a scheduled purge for expired quarantine rows and define retention policies for raw/domain/audit tables according to purpose and legal requirements.
