# Tooling and Data Review — 2026-09-16

This review records deliberate ADOPT / KEEP / RESERVE / REJECT decisions so the project does not accumulate overlapping tools.

## WhatsApp providers

| Component | Decision | Rationale |
|---|---|---|
| Meta WhatsApp Cloud API | KEEP — PRIMARY | Official provider and lowest protocol-risk path for business messaging. |
| WPPConnect | KEEP — OPTIONAL / ISOLATED | Active project and useful for authorized existing-group scenarios. It stays behind the provider port and outside core business logic. Upstream is LGPL-3.0; terms/stability must be reviewed before production use. |
| WhiskeySockets/Baileys | BENCHMARK / CONTINGENCY | Very active MIT-licensed socket-based WhatsApp Web library. More permissive than WPPConnect but would move session persistence, reconnects and WhatsApp-Web operational complexity into this codebase. Adopt only if measured reliability/licensing benefits justify replacing the isolated WPPConnect adapter. |
| Evolution API | REJECT AS CORE DEPENDENCY | Capable platform, but adopting it now would duplicate provider abstraction, queueing, AI integration, storage and operational logic already implemented here. |

## Runtime and workflows

| Component | Decision | Rationale |
|---|---|---|
| PostgreSQL | KEEP | Single transactional source of truth for WhatsApp AI. |
| pg-boss | KEEP | Active, MIT, PostgreSQL-native durable jobs. Avoids introducing Redis solely for queues. |
| BullMQ/Redis | REJECT FOR CURRENT SCOPE | Adds a second stateful datastore without a demonstrated requirement. |
| Temporal | RESERVE | Appropriate only if future distributed, long-running workflows exceed pg-boss + outbox semantics. Do not run both by default. |

## Observability

| Component | Decision | Rationale |
|---|---|---|
| @prometheus-io/client | KEEP | Official successor to deprecated prom-client; metrics stay vendor-neutral. |
| OpenTelemetry | RESERVE / NEXT OBSERVABILITY STEP | Add traces when a real OTLP collector/backend exists. Avoid telemetry with nowhere operational to send it. |
| Langfuse | BENCHMARK | Useful for LLM traces/evals, but not adopted until it adds value beyond Prometheus + future OTLP. Avoid duplicate observability stacks. |

## File and content processing

| Component | Decision | Rationale |
|---|---|---|
| file-type 22.1.0 | ADOPT | Replaces the hand-written four-signature detector and fails closed on unsupported binary formats. Requires Node 22, already the project baseline. |
| SheetJS CE 0.20.3 authoritative distribution | ADOPT | Replaces the stale npm-registry xlsx 0.18.5 line. Pin exact source. Vendor the package after the first network-enabled release gate so builds do not depend permanently on an external CDN. |
| ExcelJS | REJECT FOR PARSING REPLACEMENT | No demonstrated benefit for the current read/extract path; replacement would add migration risk without removing the need for file validation. |
| ClamAV | KEEP | Independent malware gate before parsers/LLMs see uploaded content. |

## Security and CI

| Component | Decision | Rationale |
|---|---|---|
| Gitleaks | KEEP | Repository-history secret scanning. |
| Trivy | KEEP | Filesystem dependency/misconfiguration and production-container scanning. Secret scanning is left to Gitleaks to avoid duplication. |
| CodeQL security-extended | KEEP | Static application security analysis. |
| Dependabot | KEEP | Dependency and GitHub Action update signal; release still requires the full gate. |

All external GitHub Actions used by release/security workflows are pinned to immutable commit SHAs. Concurrency cancels stale runs to reduce runner consumption.

## Canonical reference data

Runtime entity resolution must evolve away from small hard-coded alias maps. Canonical reference data is ingested and cached locally; external APIs/files are sources, not synchronous runtime dependencies.

| Domain | Canonical source | Intended use |
|---|---|---|
| Brazilian municipalities | IBGE Localidades / Registro de Referência de Municípios | IBGE code, canonical municipality name, UF and aliases. |
| Companies / establishments | Receita Federal CNPJ open data | CNPJ, legal name, trade name, registration status and address-based matching. Must support the alphanumeric CNPJ format introduced in 2026; never model CNPJ as numeric. |
| Road freight carriers | ANTT RNTRC open data | RNTRC, CNPJ/CPF identifier, carrier name, status, category, municipality and UF. |

### Data governance

- Primary/official source wins over GitHub mirrors.
- Preserve source, reference date, publication/update date and collection date.
- Do not send full public registries to an LLM for resolution; index normalized deterministic keys locally.
- PII minimization applies even when a field appears in an open dataset. Store only fields required for the stated business purpose.
- Exact identifiers and canonical aliases outrank fuzzy matching. Fuzzy or model-assisted matches must carry confidence and be reviewable.
- Refresh reference datasets incrementally where possible and atomically swap validated snapshots.

## Next adoption gates

1. Generate and commit a lockfile on a network-enabled runner, switch CI/Docker to `npm ci`, and vendor SheetJS 0.20.3 with license/NOTICE.
2. Run the complete acceptance matrix on one candidate commit.
3. Add reference-data schema/importers for IBGE, Receita CNPJ and RNTRC and replace the hard-coded resolver only with integration/golden tests in the same candidate.
4. Add OpenTelemetry only together with a deployed collector/backend and tested redaction policy.
5. Re-evaluate Baileys vs WPPConnect using authorized real-group reliability tests before changing the optional connector.
