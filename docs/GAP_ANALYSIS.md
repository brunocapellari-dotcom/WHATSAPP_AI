# Gap Analysis — repository audit

Initial audit on 2026-09-15 found the newly created repository empty, so every implementation capability was `FALTA` and there was no legacy code to preserve or replace. The foundation in this repository closes the architectural gaps without introducing a disposable prototype.

| Capability | Status after foundation | Priority / remaining evidence |
|---|---|---|
| Architecture/backend/database | EXISTE | P0: CI + staging validation |
| Frontend/operator console | FALTA | P2; not required by current operational gate, add only if workflow needs it |
| Auth/webhook auth | PARCIAL | P0 production: identity provider/admin auth; webhooks/internal API already protected |
| Multi-tenancy | EXISTE | P0 PostgreSQL RLS automated test |
| Meta provider | EXISTE / UNVERIFIED REAL | P0 credentials + real webhook/send/media test |
| Existing-group connector | PARCIAL | P0 only if required; WPPConnect adapter must pass risk/terms/stability review |
| Workers/queues/scheduler | EXISTE | P1 pg-boss; Temporal reserved, not duplicated |
| CRM/Business tools | EXISTE | P0 connect real catalog/ERP sources per tenant before live sales |
| RAG | NOT ADOPTED | P3; add only with measured retrieval need |
| MCP | RESERVE | P3; expose controlled capabilities later if an internal client needs MCP |
| Multimodal | EXISTE / UNVERIFIED REAL | P0 live API + ClamAV staging tests |
| Freight extraction/entity/dedup | EXISTE | P0 expand golden corpus with real authorized messages |
| AgroLog integration | EXISTE / UNVERIFIED REAL | P0 contract/staging Gateway test |
| Observability | PARCIAL | P1 metrics/logs exist; add OTLP traces only when collector endpoint is deployed |
| Security scanning | EXISTE | P0 CI must pass CodeQL/Gitleaks/Trivy/npm audit |
| Backups/restore | FALTA INFRA | P0 configure managed DB backups and execute restore rehearsal |
| CI/CD/deployment | EXISTE | P0 first GitHub run must pass |
| Documentation | EXISTE | update on every material architecture change |

The project is not labeled production-operational until every P0 staging item has objective evidence.
