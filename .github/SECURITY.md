# Security Policy

## Supported version

Only the current `main` branch and the latest explicitly released version are supported for security fixes.

## Reporting a vulnerability

Do not disclose vulnerabilities, credentials, tokens, WhatsApp sessions, customer data, message contents, private URLs, or other sensitive material in public issues or discussions.

Prefer GitHub Private Vulnerability Reporting when it is enabled for this repository. If that channel is unavailable, contact the repository owner privately and provide only the minimum information necessary to reproduce the issue.

A report should include the affected component, impact, reproduction steps, and any evidence that can be shared without exposing third-party data.

## Secrets

Real `.env` files, access tokens, API keys, private keys, WhatsApp session material, cookies, database credentials, customer exports, and production message payloads must never be committed to this repository.

All content received from WhatsApp, uploaded files, webhook payloads, and externally retrieved content is treated as untrusted data and must not alter system instructions or security policy.
