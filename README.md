# WhatsApp AI

Plataforma própria, self-hosted e zero-cost de inteligência e automação sobre WhatsApp.

## Domínios

- **WhatsApp Business AI** — atendimento, vendas, preços, estoque, orçamento, pedido, agenda, CRM, follow-up, aprovação humana e handoff.
- **WhatsApp Intelligence** — coleta autorizada e tratamento de mensagens relevantes.
- **WhatsApp Freight Intelligence** — extração/deduplicação de ofertas e embarques para o AgroLog MT.

> Source available, not open source. O repositório é proprietário e `UNLICENSED`. Veja `LICENSE`.

## Regra de custo

`ZERO_COST_MODE=true` é o caminho canônico.

O sistema não exige API paga, SaaS pago, cloud gerenciada ou runner hospedado para operar. O stack padrão roda localmente com PostgreSQL, WPPConnect, Ollama/Qwen3-VL, whisper.cpp, ClamAV, FFmpeg e Poppler.

Custos físicos de hardware, energia, armazenamento e conectividade continuam existindo.

## Stack canônico

- Node.js >= 22.12;
- Fastify 5;
- PostgreSQL 17;
- pg-boss;
- WPPConnect Server 2.10.27;
- Ollama 0.34.2;
- Qwen3-VL 4B Instruct;
- whisper.cpp 1.9.4;
- ClamAV 1.5.4;
- SheetJS CE + Mammoth em parser isolado;
- Semgrep CE + Gitleaks + Trivy no Release Gate.

## Segurança essencial

- WhatsApp é sempre dado não confiável.
- Payload original: quarantine criptografada e temporária.
- Dados governados: minimização e pseudonimização.
- RLS/FORCE RLS + FKs compostas por tenant.
- Operadores usam tokens locais hashed, vinculados a tenant e papel; approvals exigem SUPERVISOR/ADMIN.
- Arquivos: tamanho, magic bytes, MIME, ZIP expansion, ClamAV e parser isolado.
- LLM local não acessa banco/shell/secrets diretamente.
- Ferramentas são Zod/JSON-Schema + política determinística.
- FINANCIAL/IRREVERSIBLE exigem approval request humano.
- Handoff suspende IA.
- Envio automático, follow-up e resposta humana usam estados anti-duplicação.
- Resultado de entrega ambíguo nunca é reenviado automaticamente.

## Providers

### WPPConnect

Caminho self-hosted para cenários autorizados de WhatsApp Web e grupos existentes.

A coleta padrão combina `all-new-messages` + `all-unread-messages`, grava o lote no durable inbox e só depois marca chats como vistos.

### Meta Cloud

Adapter opcional. Credenciais de envio são rejeitadas enquanto `ZERO_COST_MODE=true`.

## Freight pipeline

```text
message
→ relevance
→ extraction
→ entity resolution (exact → pg_trgm conservador → fallback)
→ deduplication
→ quality control
→ FreightObservation/FreightEvent
→ transactional outbox
→ local AgroLog NDJSON
```

Cada campo mantém a classe epistemológica:
`OBSERVADO`, `INFERIDO`, `ESTIMADO` ou `CONFIRMADO_EXTERNAMENTE`.

## Business AI

Ferramentas determinísticas:

`buscar_produto`, `consultar_preco`, `consultar_estoque`, `criar_cliente`,
`criar_lead`, `criar_orcamento`, `criar_pedido`, `consultar_pedido`,
`agendar`, `registrar_pagamento`, `criar_followup`, `transferir_humano`.

O modelo recebe o JSON Schema real de cada ferramenta. Respostas após ferramentas são sintetizadas a partir dos outputs reais.

## Operação humana

API interna usa bearer tokens locais vinculados a `tenantId`, `operatorReference` e papel (`OPERATOR`, `SUPERVISOR`, `ADMIN`). O token em claro só é devolvido na emissão; o banco guarda apenas hash.

Permite:

- listar e abrir fila de handoff;
- assumir conversa;
- responder com `requestId` idempotente;
- liberar atendimento;
- retomar IA;
- encerrar;
- listar/inspecionar/aprovar/rejeitar ações financeiras; listagem/decisão de approvals exige `SUPERVISOR` ou `ADMIN`.

O painel visual permanece separado e só deve ser adicionado quando trouxer ganho operacional real.

## Dados canônicos

- Municípios: IBGE.
- Empresas: contrato NDJSON preparado para dados oficiais RFB/CNPJ.
- Transportadores: sincronização direta do datastore oficial ANTT/RNTRC; importa somente organizações ativas e exclui CPF/TAC do catálogo global.
- IDs externos são texto; CNPJ nunca é tratado como número.

`canonical_entities` global é legível por tenants, mas gravável apenas pela identidade privilegiada de dados/migração. `canonical_entity_aliases` mantém índices `pg_trgm`; matches registram `EXACT`, `FUZZY` ou `FALLBACK` com confiança no próprio FreightObservation.

## Executar localmente

1. Copie `.env.example` para `.env` e gere segredos próprios.
2. `docker compose up --build`.
3. Conclua a sessão autorizada do WPPConnect quando necessário.
4. Live: `GET /health/live`.
5. Ready: `GET /health/ready`.
6. Metrics: `GET /metrics`.

## Release Gate

A candidata oficial exige `package-lock.json` comprometido e executa:

```bash
npm run release:gate
```

O gate roda lint, typecheck, migrations, todos os testes, build, container, backup/restore, npm audit, Semgrep, Gitleaks, Trivy, SBOM e validação do Compose.

“100% testado” significa 100% da `docs/ACCEPTANCE_MATRIX.md` na mesma candidata — não cobertura artificial de linhas.

## Estado

O projeto continua em branch candidata e não deve ser considerado `OPERATIONAL` nem ser mergeado em `main` até existir `package-lock.json` reproduzível e o Release Gate integral estiver verde.

Veja:
- `docs/ARCHITECTURE.md`
- `docs/ZERO_COST_POLICY.md`
- `docs/TOOLING_REVIEW_2026-09-28.md`
- `docs/GAP_ANALYSIS.md`
- `docs/ACCEPTANCE_MATRIX.md`
