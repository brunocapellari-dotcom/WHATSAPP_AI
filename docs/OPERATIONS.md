# Operations

## Deployment canônico zero-cost

### Pré-requisitos

- máquina Linux/Windows+WSL/macOS com Docker;
- Node.js >= 22.12 para desenvolvimento/gate no host;
- espaço local para PostgreSQL, modelos Ollama/Whisper, ClamAV e backups;
- acesso autorizado à conta WhatsApp usada pelo WPPConnect.

### Inicialização

1. Copie `.env.example` para `.env`.
2. Gere segredos próprios para encryption/HMAC/internal API/WPP.
3. Execute `docker compose up --build`.
4. O Compose:
   - sobe PostgreSQL;
   - atualiza ClamAV;
   - sobe Ollama e baixa Qwen3-VL;
   - baixa o modelo multilingual do whisper.cpp;
   - sobe WPPConnect;
   - executa migrations;
   - cria tenant/collector WPP default;
   - inicia API e worker.
5. Complete a sessão autorizada do WPPConnect.
6. Valide `/health/live`, `/health/ready` e `/metrics`.

## Worker

O worker concentra funções cross-tenant controladas:

- drain do durable webhook inbox;
- WPP reconciliation;
- AgroLog outbox;
- follow-up delivery;
- quarantine purge.

Em produção, ele exige `WORKER_DATABASE_URL` própria. A API não deve compartilhar privilégios BYPASSRLS.

## Business / handoff

Quando `transferir_humano` é persistido:

- conversa vira `WAITING_HUMAN`;
- novas mensagens continuam sendo governadas/armazenadas;
- Agent Runtime fica suspenso;
- operador assume via API e estado vira `HUMAN`;
- operador pode responder com `requestId` idempotente;
- somente `resume-ai` retorna para `OPEN`.

## Aprovações

FINANCIAL/IRREVERSIBLE:

1. agente valida schema;
2. nenhuma ferramenta do plano é executada;
3. `approval_request` PENDING é criado;
4. conversa entra em handoff;
5. operador inspeciona inputs;
6. approve muda primeiro para EXECUTING;
7. ferramenta determinística é executada;
8. sucesso vira EXECUTED.

EXECUTING não é reexecutado automaticamente após falha/crash. Exige reconciliação humana.

## Follow-up

Follow-ups guardam conversation routing indiretamente via `conversation_id`.

Estados:
`PENDING → SENDING → DONE`.

Falha definitivamente pré-envio:
`SENDING → PENDING` com backoff.

Resultado ambíguo/crash após início:
`SENDING → DELIVERY_UNCERTAIN` + handoff humano.

## AgroLog

Default zero-cost:

```text
transactional outbox → /data/agrolog-export/agrolog-events-YYYY-MM-DD.ndjson
```

Arquivo é sincronizado com `fsync` antes de marcar outbox como publicado. Pode haver duplicata após crash entre fsync e commit; downstream deve deduplicar por `idempotencyKey`.

HTTP Gateway é opcional e, em zero-cost mode, precisa ser endpoint privado/local.

## Backup

Criar backup:

```bash
npm run db:backup
```

O script usa `pg_dump -Fc`, chmod restritivo e SHA-256.

Ensaio de restore:

```bash
npm run db:restore:rehearsal -- backups/whatsapp_ai-....dump
```

O Release Gate executa backup + restore automaticamente.

## Dados canônicos

IBGE:

```bash
npm run data:sync:ibge
```

Empresas/transportadoras/outros catálogos normalizados:

```bash
npm run data:import:entities -- arquivo.ndjson
```

Carga global em produção exige `MIGRATION_DATABASE_URL`.

## Release

Primeiro lockfile:

```bash
npm run lock:prepare
git add package-lock.json
git commit
```

Gate integral:

```bash
npm run release:gate
```

Qualquer mudança posterior invalida o resultado anterior e exige execução integral novamente.

## Failure behavior

- inbound inválido/malicioso: reject/fail closed;
- duplicate: idempotent no-op;
- scanner/parser: fail closed;
- local AI indisponível: Business handoff; Freight não inventa dado;
- provider indisponível antes de send: retry quando seguro;
- delivery ambígua: sem auto-resend;
- AgroLog local indisponível: outbox permanece pending;
- follow-up esgota retries: FAILED + handoff;
- approval EXECUTING ambígua: revisão humana.

## Retention

Quarantine é temporária, criptografada e purgada pelo worker.

A janela técnica default não substitui política jurídica. Governed raw, audit, CRM, approvals e domain events precisam de retenção definida pelo uso real antes de operação comercial.
