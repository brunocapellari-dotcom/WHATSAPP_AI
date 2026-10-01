# Tooling Review — 2026-09-22

This review compares the current WhatsApp AI stack against actively maintained GitHub alternatives. The decision rule is: improve reliability/security/maintainability without adding mandatory cost or duplicate infrastructure.

## Decisions

| Area | Candidates reviewed | Decision | Reason |
|---|---|---|---|
| Existing WhatsApp groups | WPPConnect Server 2.10.27; Baileys 7.0.0-rc14; whatsapp-web.js 1.34.7; Evolution API 2.3.7 | KEEP WPPConnect | Stable released server, existing adapter/reconciliation already hardened. Baileys latest release is still RC and would move session/reconnect/API responsibilities into this repo. whatsapp-web.js would reintroduce browser/session orchestration. Evolution adds overlapping platform features and license-specific conditions. |
| PostgreSQL jobs | pg-boss 12.33.4; Graphile Worker 0.18.0 | KEEP pg-boss; pin exact | Mature major release, Postgres-only, Node 22 support, existing DLQ/retry implementation. A swap provides no measured benefit. |
| Local LLM/VLM | Ollama 0.34.2; llama.cpp/llama-server | KEEP Ollama | Both support local inference. llama-server now supports multimodal/OpenAI-compatible APIs, but Ollama directly supports JSON Schema structured outputs with vision and simpler model lifecycle. Removing Ollama would add GGUF/mmproj operational work without reducing monetary cost. |
| Vision/text model | Qwen3-VL 4B Instruct | KEEP | One local model covers text + vision, avoiding duplicate LLM/VLM runtimes. Upstream Qwen3-VL license is Apache-2.0. |
| Speech | whisper.cpp 1.9.4 | KEEP | MIT, CPU/GPU capable, local server, multilingual model support, no Python service required. |
| XLSX | SheetJS CE 0.20.3; ExcelJS 4.4.0 | KEEP SheetJS | ExcelJS latest release is from 2023. SheetJS is already isolated behind archive limits + worker memory/time limits. Replacing it would reduce format coverage without a demonstrated security gain. |
| DOCX | Mammoth 1.12.3 | KEEP; update/pin | Current upstream package remains maintained. It is isolated behind ZIP validation and worker limits. |
| MIME detection | file-type 22.1.1 | UPDATE | 22.1.1 fixes OOXML stream detection; directly relevant to XLSX/DOCX validation. |
| HTTP runtime | Fastify 5.12.5 | UPDATE | Current Fastify 5 security release. Do not move to Fastify 6 alpha. |
| Rate limiting | @fastify/rate-limit 11.2.0 | UPDATE | Security release; previous major constraint would not receive it. |
| SAST | CodeQL; Semgrep CE 1.177.0 | KEEP Semgrep CE offline | Works on private/self-hosted infrastructure without Advanced Security dependency. Local rules are versioned and telemetry is disabled. |
| Secrets | Gitleaks 8.30.1 | KEEP | Dedicated repository-history secret scanner; no overlap with SAST. |
| Vuln/config/SBOM | Trivy 0.74.0 | KEEP + expand | One local tool covers filesystem/config/image vulnerabilities and CycloneDX SBOM. Avoid adding Grype/Syft as duplicates. |
| Backup | pg_dump/pg_restore; pgBackRest/WAL-G | KEEP native PostgreSQL for current scale | Automated custom-format backup + checksum + restore rehearsal closes current release gate with minimal operational surface. Re-evaluate PITR tools when RPO/RTO or data volume requires WAL archiving. |
| CSV ingestion | csv-parse 7.0.2; custom parser | DO NOT ADD NOW | Canonical entity exchange can use validated NDJSON and avoid delimiter/encoding ambiguity plus another dependency. |

## Removed / rejected redundancy

- OpenAI SDK/runtime: removed from the zero-cost path.
- Separate text LLM + vision model: replaced by one local Qwen3-VL runtime.
- GitHub-hosted CI + separate CodeQL/Security workflows: replaced by one self-hosted whole-project Release Gate.
- Separate SBOM tool: unnecessary because Trivy already emits CycloneDX.
- Redis queue: unnecessary while pg-boss satisfies durable jobs on PostgreSQL.
- Graphile Worker: not adopted alongside pg-boss.
- Evolution API: not adopted as a second automation platform.
- ExcelJS: not added alongside SheetJS.
- Phoenix/Tempo/Grafana stack: deferred until trace history/operator needs justify the services.

## Mandatory zero-cost invariant

The canonical release path must not require:
- paid API tokens;
- hosted LLM/transcription usage;
- paid CI runners;
- paid observability SaaS;
- managed cloud database/object storage;
- direct cloud-only AgroLog delivery.

Local hardware, electricity, internet connectivity and disk capacity remain physical operating requirements and are outside software billing.

## Re-evaluation triggers

A rejected/reserved tool may replace the current tool only when the same acceptance corpus demonstrates at least one material improvement in reliability, security, maintenance burden, throughput, resource use or licensing/governance, with no regression in the full Release Acceptance Matrix.
