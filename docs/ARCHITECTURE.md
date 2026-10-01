# Arquitetura canônica

## Princípio operacional

A candidata oficial opera com `ZERO_COST_MODE=true`: nenhum componente essencial depende de API paga, SaaS, runner hospedado ou cloud gerenciada.

## Fluxo

```text
WPPConnect autorizado / Meta opcional
        |
        v
Webhook autenticado ou Reconciliation
        |
        v
Durable Webhook Inbox
        |
        v
Encrypted Quarantine
        |
        +--> Governed Raw Message
                |
                +--> BUSINESS
                |      |
                |      +--> Local Qwen3-VL planning
                |      +--> deterministic ToolRegistry
                |      +--> READ/WRITE
                |      +--> FINANCIAL/IRREVERSIBLE -> Approval Request -> Human
                |      +--> Human Handoff -> AI suspended
                |      +--> Operator Outbound -> idempotent delivery state
                |      +--> Follow-up -> pg-boss -> duplicate-safe delivery
                |
                +--> FREIGHT
                       |
                       +--> relevance/extraction
                       +--> canonical entity resolution
                       +--> dedupe/quality
                       +--> FreightObservation/FreightEvent
                       +--> Transactional Outbox
                                |
                                +--> local NDJSON (default)
                                +--> internal AgroLog Gateway (optional)
```

## Bounded contexts

1. **Provider & Ingestion** — capabilities, auth, normalization, reconciliation, durable inbox, idempotency e health.
2. **Privacy & Security** — quarantine criptografada, PII minimization, MIME/magic bytes, ZIP expansion limits, ClamAV, SSRF, policy, audit.
3. **Freight Intelligence** — relevance, structured extraction, canonical entities, deduplication, quality, observations/events e outbox.
4. **Business AI** — Agent Runtime único com Front Desk, Sales, Quote, CRM, Scheduling, Support e Human Handoff como papéis/workflows.
5. **Human Operations** — autenticação local de operador, claim/release/resume/close de conversa, envio manual idempotente e aprovação de ações de alto risco com RBAC.
6. **Operations** — PostgreSQL, pg-boss, Prometheus metrics, backup/restore rehearsal, local Release Gate e security tooling.

## Dados principais

- `webhook_inbox`: aceitação durável antes de processamento.
- `quarantine_messages`: payload original criptografado e temporário.
- `raw_messages`: mensagem normalizada governada.
- `freight_observations`: cada observação real.
- `freight_events`: evento lógico consolidado.
- `canonical_entities`: catálogo global/tenant-scoped com provenance.
- `canonical_entity_aliases`: projeção indexada com `pg_trgm` para resolução exact/fuzzy conservadora.
- `operator_tokens`: credenciais locais de operador armazenadas somente como hash, vinculadas a tenant/identidade/papel.
- `business_message_runs`: idempotência e estado de entrega automática.
- `operator_outbound_messages`: idempotência de respostas humanas.
- `approval_requests`: workflow de aprovação financeira/irreversível.
- `followups`: agendamento e entrega durável.
- `outbox_events`: integração AgroLog at-least-once.
- CRM/comércio: conversations, customers, leads, quotes, orders, appointments, payments, products, prices e inventory.

## Multi-tenancy

Tabelas de domínio usam RLS + FORCE RLS. Operações normais usam `set_config('app.tenant_id', ..., true)` dentro de transação.

O catálogo canônico permite SELECT de registros globais (`tenant_id IS NULL`) e do próprio tenant. Um tenant não pode inserir/alterar/apagar registros globais; carga global exige identidade privilegiada de dados/migração. Aliases são projetados em tabela própria com GIN/`pg_trgm`; fuzzy só é aceito com limiar alto e margem contra ambiguidade.

Relacionamentos sensíveis usam chaves compostas `(tenant_id,id)` para impedir referência cruzada mesmo se houver bug na aplicação.

Operadores não escolhem `tenantId`/identidade em request. O bearer token determina tenant, operador e papel. `OPERATOR` atende conversas; approvals são visíveis/decididos apenas por `SUPERVISOR`/`ADMIN`.

O worker cross-tenant exige `WORKER_DATABASE_URL` privilegiada em produção.

## IA local

- Runtime: Ollama.
- Modelo default: `qwen3-vl:4b-instruct`.
- Structured outputs: JSON Schema.
- Texto e visão usam o mesmo modelo para reduzir redundância.
- Áudio: whisper.cpp local.
- PDF: Poppler + Qwen3-VL para páginas escaneadas.
- XLSX/DOCX: parser isolado em worker thread com timeout/memory limits.

O modelo não acessa banco, shell, secrets ou rede arbitrária. Ele cria plano estruturado; ferramentas determinísticas validam schema/risco/tenant.

## Entrega e idempotência

Toda entrega WhatsApp segue a distinção:

- falha comprovadamente pré-envio: retry permitido;
- provider confirmou envio: persistir `SENT`;
- resultado ambíguo ou crash após `SENDING`: `DELIVERY_UNCERTAIN`, sem reenvio automático.

A regra vale para Business AI, follow-ups e mensagens humanas.

## Filas e workflows

`pg-boss` permanece como única fila durável sobre PostgreSQL. Não há Redis/NATS/Temporal no caminho canônico.

Temporal só entra quando houver workflow distribuído de longa duração que não possa ser modelado adequadamente no estado transacional atual.

## Segurança/release

Release Gate self-hosted executa:

- npm ci com lockfile comprometido;
- Biome;
- TypeScript;
- migrations;
- matriz completa de testes;
- build/container;
- backup + restore rehearsal;
- npm audit;
- Semgrep CE offline;
- Gitleaks;
- Trivy filesystem/config/image;
- CycloneDX SBOM;
- compose validation.

Containers de aplicação usam filesystem read-only, `no-new-privileges`, capabilities removidas e somente tmpfs/volumes necessários graváveis.

Veja `ZERO_COST_POLICY.md` e `TOOLING_REVIEW_2026-09-28.md`.
