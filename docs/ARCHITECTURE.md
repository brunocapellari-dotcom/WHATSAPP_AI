# Arquitetura canônica

## Bounded contexts

1. **Provider & Ingestion** — webhooks, assinatura, normalização, idempotência, capabilities e health.
2. **Privacy & Security** — quarantine criptografada, minimização, MIME/magic bytes, malware, SSRF, policy/tool authorization e audit log.
3. **Freight Intelligence** — relevance, extraction, entity resolution, deduplication, quality, observation/event e AgroLog outbox.
4. **Business AI** — um Agent Runtime compartilhado; Front Desk, Sales, Quote, CRM, Scheduling, Support e Human Handoff são papéis/workflows, não microserviços duplicados.
5. **Operations** — PostgreSQL, `pg-boss`, metrics, logs, CI/CD e security gates.

## Modelo de dados

- `quarantine_messages`: payload original criptografado, TTL e disposition.
- `raw_messages`: evento normalizado governado, sem payload bruto aberto.
- `freight_observations`: uma linha por observação real.
- `freight_events`: consolidação lógica por fingerprint/offer id.
- `outbox_events`: entrega idempotente ao AgroLog.
- CRM: `conversations`, `customers`, `leads`, `quotes`, `orders`, `appointments`, `followups`, `payments`.
- comércio: `products`, `product_prices`, `inventory`.

## Multi-tenancy

Tabelas de domínio têm RLS + FORCE RLS. Toda operação da API usa `set_config('app.tenant_id', ..., true)` dentro de transação. `collectors` fica fora de RLS porque a resolução do webhook ocorre antes de o tenant ser conhecido; webhook autenticado + collector id resolvem o tenant. `outbox_events` fica fora de RLS para o worker cross-tenant e nunca é exposto diretamente ao usuário.

## Agentes

Os agentes definidos pelo produto são especializações lógicas no mesmo runtime. O LLM não possui acesso direto a banco, shell, rede ou credenciais. Ele devolve plano estruturado; `ToolRegistry` valida schema, risco, tenant e aprovação antes da execução.

## Evolução sem tool-sprawl

- **ADOPT**: PostgreSQL, pg-boss, Fastify, Zod, OpenAI Responses/Structured Outputs, Prometheus metrics, CodeQL, Gitleaks, Trivy, ClamAV.
- **OPTIONAL PROVIDER**: WPPConnect.
- **RESERVE**: Temporal (workflows distribuídos longos), pgvector/RAG (somente quando houver caso medido), Chatwoot (somente se substituir conscientemente a interface humana própria).
- **REJECT AS CORE**: acoplamento direto a Baileys/Evolution/WPPConnect; Redis apenas para fila; múltiplos agent frameworks sobrepostos.
