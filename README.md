# WhatsApp AI

Plataforma própria de inteligência e automação sobre WhatsApp, com dois domínios no mesmo núcleo seguro:

- **WhatsApp Business AI** — atendimento, vendas, orçamento, pedidos, agenda, CRM, follow-up e handoff humano por ferramentas estruturadas.
- **WhatsApp Intelligence** — coleta autorizada e tratamento de mensagens relevantes; a aplicação inicial é **WhatsApp Freight Intelligence**, que produz eventos estruturados para o AgroLog MT.

## Princípios

- conteúdo de WhatsApp é sempre **dado não confiável**;
- LLM interpreta, mas ações são executadas apenas por ferramentas estruturadas e políticas determinísticas;
- multi-tenancy por `tenant_id` + PostgreSQL RLS;
- `WhatsAppProvider` desacopla o domínio dos conectores;
- payload original fica em quarentena criptografada e temporária; o armazenamento governado persiste somente o necessário;
- `FreightObservation` preserva cada ocorrência; `FreightEvent` consolida reposts sem perder provenance;
- verdade é classificada por campo: `OBSERVADO`, `INFERIDO`, `ESTIMADO`, `CONFIRMADO_EXTERNAMENTE`;
- integração com AgroLog usa Transactional Outbox e idempotência, nunca escrita direta nas tabelas analíticas.

## Arquitetura

```text
WhatsApp Provider
      |
      v
Webhook/Auth/Rate Limit
      |
      v
Encrypted Quarantine ----> reject/discard/expire
      |
      +--> governed Raw Message
              |
              +--> BUSINESS -> Agent Runtime -> Policy -> Structured Tools -> Reply/Handoff
              |
              +--> FREIGHT -> Relevance -> Extraction -> Entity Resolution
                               -> Dedup -> Quality -> FreightObservation/FreightEvent
                               -> Outbox -> AgroLog Gateway
```

O projeto é um **modular monolith** em TypeScript/Node 22. PostgreSQL é a fonte transacional; `pg-boss` executa jobs duráveis sem introduzir Redis. Temporal fica reservado para workflows distribuídos de longa duração se houver evidência de necessidade.

## Providers

- `meta-cloud`: provider oficial. Graph API padrão `v26.0`. `managedGroups` e `existingGroups` são capacidades diferentes; o provider oficial não é tratado como acesso geral a grupos preexistentes.
- `wppconnect`: adapter opcional e isolado para cenários autorizados que dependam de WhatsApp Web. Ativação exige avaliação operacional, jurídica e de risco.
- `mock`: provider determinístico exclusivo para testes.

## Executar localmente

1. Copie `.env.example` para `.env` e substitua segredos de exemplo.
2. `docker compose run --rm migrate`
3. `docker compose up --build api worker`
4. Live: `GET /health/live`; ready: `GET /health/ready`; métricas: `GET /metrics`.

Nunca comite `.env`, tokens, cookies ou sessões do WhatsApp.

## Testes

`npm test` executa a matriz automatizada: Freight E2E, Business E2E, Test Lab, multimodal, provider Meta, deduplicação, entity resolution e segurança. Em CI também são executados PostgreSQL/RLS, migrations, typecheck, build, Docker build, CodeQL, Gitleaks, Trivy e `npm audit`.

O termo “100% testado” neste projeto significa **100% dos cenários obrigatórios da Acceptance Matrix aprovados**, não uma taxa artificial de 100% de cobertura de linhas.

## Estado operacional

A arquitetura e a implementação base são executáveis sem depender de um provider específico. Produção só pode ser marcada como `OPERATIONAL` depois dos testes com credenciais reais autorizadas de WhatsApp, storage/ClamAV, OpenAI, AgroLog Gateway, backup/restore e testes de falha em staging. Veja `docs/GAP_ANALYSIS.md` e `docs/ACCEPTANCE_MATRIX.md`.
