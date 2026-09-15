# Security model

## Trust boundary

WhatsApp text, URL, audio, image, PDF, spreadsheet and documents are untrusted. Instructions inside them never modify system rules or permissions.

Inbound path: signature/auth → rate limit → normalization → encrypted quarantine → attachment validation/malware → policy/relevance → governed storage/domain processing.

## Controls

- HMAC/webhook signature validation over raw bytes and constant-time comparison;
- idempotency by provider message id and outbox idempotency key;
- RLS/FORCE RLS for tenant domain tables;
- AES-256-GCM quarantine encryption; HMAC pseudonymization of sender identifiers;
- tool schemas + deterministic risk policy; financial/irreversible actions require explicit approval;
- MIME + magic-byte validation, max size and ClamAV fail-closed processing;
- safe URL resolver blocks localhost/private/link-local targets to reduce SSRF;
- no shell/SQL/network tools exposed to the LLM;
- CodeQL, Gitleaks, Trivy and npm audit in CI;
- secrets only through environment/secret manager; `.env` ignored.

## Production gates

Production requires TLS termination, managed secret vault, encrypted managed PostgreSQL/storage, least-privilege runtime identities, network egress policy, tested backups/restores, log retention and incident response. WPPConnect activation requires an explicit provider risk review.
