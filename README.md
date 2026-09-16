# WhatsApp AI

Plataforma própria de inteligência e automação sobre WhatsApp, com dois domínios no mesmo núcleo seguro:

- **WhatsApp Business AI** — atendimento, vendas, orçamento, pedidos, agenda, CRM, follow-up e handoff humano por ferramentas estruturadas.
- **WhatsApp Intelligence** — coleta autorizada e tratamento de mensagens relevantes; a aplicação inicial é **WhatsApp Freight Intelligence**, que produz eventos estruturados para o AgroLog MT.

> **Source available, not open source.** Este repositório pode ser publicamente visível para transparência, revisão e infraestrutura de build, mas o software permanece proprietário e `UNLICENSED`. Veja `LICENSE`. Visibilidade pública não concede licença de uso, modificação, distribuição ou exploração comercial.

## Princípios

- conteúdo de WhatsApp é sempre **dado não confiável**;
- LLM interpreta, mas ações são executadas apenas por ferramentas estruturadas e políticas determinísticas;
- multi-tenancy por `tenant_id` + PostgreSQL RLS;
- `WhatsAppProvider` desacopla o domínio dos conectores;
- payload original fica em quarentena criptografada e temporária; o armazenamento governado persiste somente o necessário;
- `FreightObservation` preserva cada ocorrência; `FreightEvent` consolida reposts sem perder provenance;
- verdade é classificada por campo: `OBSERVADO`, `INFERIDO`, `ESTIMADO`, `CONFIRMADO_EXTERNAMENTE`;
- integração com AgroLog usa Transactional Outbox e idempotência, nunca escrita direta nas tabelas analíticas;
- dependências e providers não são acumulados em paralelo sem necessidade demonstrada.

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

- `meta-cloud`: provider oficial e primário. Graph API padrão `v26.0`. `managedGroups` e `existingGroups` são capacidades diferentes; o provider oficial não é tratado como acesso geral a grupos preexistentes.
- `wppconnect`: adapter opcional e isolado para cenários autorizados que dependam de WhatsApp Web. Ativação exige avaliação operacional, jurídica e de risco.
- Baileys é benchmark/contingência para eventual substituição do adapter de WhatsApp Web; não roda em paralelo por padrão.
- Evolution API não é dependência central porque duplicaria capacidades que já pertencem ao WhatsApp AI.
- `mock`: provider determinístico exclusivo para testes.

## Segurança de conteúdo

Arquivos recebidos passam por limite de tamanho, detecção de tipo por conteúdo (`file-type`), comparação com MIME declarado, malware scan e roteamento do parser somente pelo MIME validado. Arquivos desconhecidos ou inconsistentes falham fechados. Planilhas usam SheetJS CE 0.20.3 da distribuição autoritativa; a versão final deve manter artefato/lock reprodutível e atribuição de licença.

Nunca comite `.env`, tokens, cookies, chaves privadas, sessões do WhatsApp ou dados de clientes. Vulnerabilidades devem seguir `.github/SECURITY.md`.

## Executar localmente

1. Copie `.env.example` para `.env` e substitua segredos de exemplo.
2. `docker compose run --rm migrate`
3. `docker compose up --build api worker`
4. Live: `GET /health/live`; ready: `GET /health/ready`; métricas: `GET /metrics`.

## Testes

`npm test` executa a matriz automatizada: Freight E2E, Business E2E, Test Lab, multimodal, provider Meta, deduplicação, entity resolution e segurança. O gate de release acrescenta lint, typecheck, migrations, PostgreSQL/RLS, build, Docker build, CodeQL `security-extended`, Gitleaks, Trivy de filesystem/imagem e `npm audit`.

O termo “100% testado” neste projeto significa **100% dos cenários obrigatórios da Acceptance Matrix aprovados na mesma versão candidata**, não uma taxa artificial de 100% de cobertura de linhas.

## Dados canônicos

A evolução da resolução de entidades usa fontes oficiais, cacheadas localmente: IBGE para municípios, Receita Federal para CNPJ/empresas e ANTT/RNTRC para transportadores. GitHub mirrors não são fonte de verdade. CNPJ deve ser tratado como identificador textual, inclusive para inscrições alfanuméricas de 2026.

## Estado operacional

A arquitetura e a implementação base são executáveis sem depender de um provider específico. Produção só pode ser marcada como `OPERATIONAL` depois que **todo** o gate passar e houver testes com credenciais reais autorizadas de WhatsApp, storage/ClamAV, OpenAI, AgroLog Gateway, backup/restore e falhas em staging. Veja `docs/GAP_ANALYSIS.md`, `docs/ACCEPTANCE_MATRIX.md` e `docs/TOOLING_REVIEW_2026-09-16.md`.
