# Gap Analysis — repository audit

Initial audit on 2026-09-15 found the newly created repository empty, so every implementation capability was `FALTA` and there was no legacy code to preserve or replace. The current candidate is a complete foundation, not a disposable prototype. `EXISTE` means implemented; it does not mean production-validated until the release gate passes.

| Capability | Current status | Priority / remaining evidence |
|---|---|---|
| Architecture/backend/database | EXISTE | P0: whole-project CI + staging validation |
| Frontend/operator console | FALTA / NOT CURRENT GATE | P2; add only when an operator workflow requires it |
| Auth/webhook auth | PARCIAL | P0 production: admin/operator identity provider; webhooks/internal API already protected |
| Multi-tenancy | EXISTE | P0: PostgreSQL RLS integration test must pass on release candidate |
| Meta provider | EXISTE / UNVERIFIED REAL | P0: authorized real webhook/send/media test |
| Existing-group connector | PARCIAL | P0 only when required: WPPConnect real-group test + terms/license/stability review; Baileys is benchmark, not duplicate runtime |
| Workers/queues/scheduler | EXISTE | pg-boss retained; no Redis/second queue; Temporal reserved |
| CRM/Business tools | EXISTE | P0 before live sales: connect real catalog/ERP sources per tenant |
| RAG | NOT ADOPTED | P3; add only with measured retrieval need |
| MCP | RESERVE | P3; expose controlled capabilities only when an internal client needs MCP |
| Multimodal | EXISTE / HARDENED / UNVERIFIED REAL | file-type validation + ClamAV + validated-MIME parser routing implemented; P0 live OpenAI/ClamAV tests remain |
| Spreadsheet parsing | HARDENED / UNVERIFIED BUILD | SheetJS CE 0.20.3 authoritative package selected; generate lockfile and vendor exact artifact on network-enabled runner |
| Freight extraction/dedup | EXISTE | P0: expand golden corpus with real authorized messages |
| Entity resolution | PARCIAL | P0/P1: replace small alias map with cached canonical IBGE + Receita CNPJ + ANTT RNTRC reference data under tests |
| AgroLog integration | EXISTE / UNVERIFIED REAL | P0: contract/staging Gateway test |
| Observability | EXISTE/PARCIAL | Prometheus metrics present; add OTLP traces only together with deployed collector/backend; do not duplicate with Langfuse by default |
| Security scanning | CONFIGURED / NOT EXECUTED | P0: CodeQL security-extended + Gitleaks history + Trivy fs/image + npm audit must pass together |
| Supply-chain pinning | EXISTE | GitHub Actions in release/security workflows pinned to immutable commit SHAs |
| Backups/restore | FALTA INFRA | P0: configure managed DB backup and execute restore rehearsal |
| CI/CD/deployment | CONFIGURED / BLOCKED BY PRIVATE RUNNERS | workflows cover build branches + manual dispatch; repository visibility/admin action is external to this connector |
| Reproducible dependencies | PARCIAL | P0: public/network-enabled runner generates candidate `package-lock.json`; commit it and switch CI/Docker to `npm ci` before final gate |
| Public-repository hardening | PARCIAL | proprietary LICENSE + GitHub security policy + ignore rules exist; Gitleaks history scan is still mandatory before treating public audit as complete |
| Documentation | EXISTE | tooling/provider decisions documented; update on every material architecture change |

## Release rule

The project is **not** labeled production-operational until every P0 item has objective evidence on the same release candidate. Passing isolated tests or mocks cannot substitute for the complete Acceptance Matrix.

## Immediate blocking sequence

1. Make the repository public only after accepting the visibility trade-off; this is an administrative GitHub action not exposed by the current connector.
2. Run CI/Security/CodeQL on the current candidate and obtain the generated lockfile artifact.
3. Commit `package-lock.json`; replace `npm install` with `npm ci` in CI, security workflow and Dockerfile; vendor SheetJS 0.20.3 with its license/notice.
4. Re-run **all** gates from zero on that exact commit.
5. Correct every failure and restart the entire gate, not only the failed test.
6. Execute authorized staging tests for Meta, optional WhatsApp-Web group connector, OpenAI multimodal, ClamAV, AgroLog Gateway and backup/restore.
7. Merge to `main` only after the full matrix is green.
