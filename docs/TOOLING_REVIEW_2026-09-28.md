# Tooling Review — 2026-09-28

## Regra de decisão

A revisão considera manutenção atual, maturidade, licença, custo obrigatório, superfície operacional, compatibilidade com Node 22/PostgreSQL e ganho real sobre o que já existe. Uma ferramenta nova só entra se substituir uma função existente ou preencher um gap objetivo.

## WhatsApp Web / grupos autorizados

### WPPConnect Server — MANTER
- release verificada: 2.10.27 (2026-09-17);
- Node 22.22.2 no upstream;
- servidor Apache-2.0;
- biblioteca interna @wppconnect-team/wppconnect 2.3.3 é LGPL-3.0-or-later;
- upstream já fornece healthcheck e persistência de sessão;
- encaixa na abstração WhatsAppProvider sem colocar protocolo WhatsApp no domínio.

### Baileys — NÃO ADOTAR EM PARALELO
- upstream ativo;
- licença MIT;
- release corrente encontrada: 7.0.0-rc14;
- exigiria trazer para este projeto sessão, reconnect, compatibilidade de protocolo e API operacional.
Reavaliar apenas se WPPConnect falhar de forma mensurável no mesmo corpus autorizado.

### whatsapp-web.js — BENCHMARK
- release estável encontrada: 1.34.7;
- ativo, mas baseado em browser/Puppeteer e não oferece vantagem operacional suficiente para manter um segundo conector.

### Evolution API — NÃO ADOTAR
- duplicaria provider abstraction, integrações e infraestrutura;
- licença contém condições adicionais de notificação/uso além do Apache-2.0.
Só reavaliar como adapter externo se surgir capability indispensável.

## Jobs PostgreSQL

### pg-boss — MANTER E FIXAR 12.33.4
- desenvolvimento ativo em setembro de 2026;
- Node >=22.12;
- PostgreSQL-only e MIT;
- já atende retries, backoff, singleton e DLQ sem Redis.

### Graphile Worker — NÃO TROCAR
- projeto ativo e tecnicamente bom;
- release 0.18.0;
- a substituição não elimina nenhum serviço nem resolve gap atual.
Evitar migração sem ganho mensurável.

## IA local

### Ollama — MANTER
- API já cobre JSON Schema/structured outputs e visão;
- reduz operação de GGUF/mmproj e gerenciamento de modelos;
- MIT;
- não exige serviço externo pago.

### llama.cpp / llama-server — RESERVA
- multimodal e endpoint compatível evoluíram;
- útil se no futuro houver necessidade de remover Ollama ou otimizar inferência;
- hoje aumentaria responsabilidade operacional sem reduzir custo.

### Qwen3-VL — MANTER COMO DEFAULT LOCAL
- texto + visão no mesmo runtime;
- licença Apache-2.0 upstream;
- evita manter LLM e VLM separados por padrão.

### whisper.cpp — MANTER
- release fixada 1.9.4;
- MIT;
- CPU/GPU local e zero cobrança por minuto.

## Documentos

### SheetJS CE 0.20.3 — MANTER
- leitura XLSX já isolada em worker com limites de archive expansion e ClamAV;
- ExcelJS 4.4.0 tem última release pública de 2023 e a troca não melhora o nosso caminho de ingestão;
- não adicionar segundo parser XLSX.

### Mammoth — ATUALIZAR/FIXAR 1.12.3
- upstream atual continua mantido;
- BSD-2-Clause;
- permanece somente dentro do parser isolado de DOCX.

### file-type — ATUALIZAR/FIXAR 22.1.1
- release de 2026-09-17 corrige especificamente detecção OOXML em streams;
- relevante para XLSX/DOCX recebidos como conteúdo não confiável.

## HTTP/runtime

Atualizados e fixados:
- Fastify 5.12.5 — release de segurança;
- @fastify/rate-limit 11.2.0 — release de segurança;
- @fastify/helmet 13.1.1;
- fastify-raw-body 6.0.1;
- Zod 4.6.5;
- pg 8.23.0;
- pg-boss 12.33.4;
- Biome 2.5.14;
- tsx 4.23.15;
- TypeScript 5.9.3.

Vitest permanece na major atual até o Release Gate poder executar a migração completa; não promover major de ferramenta de teste sem rodar todo o corpus.

## Segurança e supply chain

### Semgrep CE — MANTER
SAST local, sem cloud obrigatória e com regras próprias do projeto.

### Gitleaks — MANTER
Função exclusiva: segredos no histórico.

### Trivy — MANTER E AMPLIAR
Funções: filesystem/config/image vulnerabilities + geração de SBOM CycloneDX.

CodeQL não é requisito porque o projeto privado não pode depender de GitHub Advanced Security ou runners pagos.

## Terceira rodada — infraestrutura complementar

### pg_trgm — ADICIONADO
- extensão oficial do PostgreSQL;
- `similarity()` + índice GIN `gin_trgm_ops`;
- elimina necessidade de biblioteca fuzzy no Node;
- usado somente após alias exato, com thresholds altos, aliases curtos exact-only e rejeição de ambiguidade;
- método/confiança preservados no domínio.

### pgBackRest 2.59.2 — RESERVA
Muito ativo e tecnicamente superior quando houver necessidade real de PITR/WAL contínuo. Não entra agora porque `pg_dump -Fc` + checksum + restore rehearsal satisfaz o objetivo atual com menos operação. Reavaliar por RPO/RTO e volume, não por popularidade.

### Authelia 4.39.28 / authentik 2026.8.3 — NÃO ADICIONAR AGORA
Ambos são ativos. O backend interno agora possui tokens locais hashed, tenant-bound e RBAC. Um IdP adicional só entra quando houver UI remota/SSO/MFA multiusuário que justifique outro serviço.

### OpenTelemetry JS 2.11.0 / Loki 3.7.8 — NÃO ADICIONAR AGORA
Ativos e úteis, mas Prometheus + logs estruturados cobrem os sinais atuais. Adicionar tracing/log aggregation sem uma necessidade medida aumentaria serviços e retenção operacional.

### OpenBao 2.7.0 — RESERVA
Boa opção futura para secrets multi-host/rotação centralizada. Para o stack local atual, env/volumes privados + secrets fora do Git são mais simples.

### Autenticação local de operador — ADICIONADA
- bearer token aleatório;
- plaintext devolvido somente na emissão;
- SHA-256 persistido;
- tenant/operator/role vinculados ao token;
- `OPERATOR`, `SUPERVISOR`, `ADMIN`;
- approvals restritos a supervisor/admin;
- nenhum SaaS/IdP obrigatório.

### Container hardening — ADICIONADO
- filesystem read-only para API/worker/migrate/bootstrap;
- `no-new-privileges`;
- capabilities Linux removidas;
- tmpfs/volumes graváveis minimizados;
- senhas/tokens fracos removidos do Compose.

## Decisões desta rodada

ADICIONADO/MELHORADO:
- versões de segurança do stack Fastify;
- file-type 22.1.1;
- versões runtime fixadas;
- backup PostgreSQL + checksum;
- restore rehearsal no Release Gate;
- SBOM CycloneDX;
- Operator API para handoff humano;
- RLS que impede tenant de gravar catálogo canônico global;
- source_type reconciliation no schema;
- importador canônico NDJSON/offline para RFB/ANTT/outros catálogos;
- `pg_trgm`/alias projection para resolução fuzzy conservadora;
- autenticação/RBAC local de operador;
- container hardening e secrets explícitos no Compose.

MANTIDO:
- WPPConnect;
- pg-boss;
- Ollama + Qwen3-VL;
- whisper.cpp;
- SheetJS + Mammoth;
- PostgreSQL como única fila/banco transacional.

NÃO ADICIONADO:
- Redis;
- Temporal;
- Graphile Worker;
- Baileys paralelo;
- whatsapp-web.js paralelo;
- Evolution API;
- llama.cpp paralelo;
- ExcelJS;
- parser CSV extra;
- Phoenix/Grafana/Tempo neste estágio;
- pgBackRest até existir requisito de PITR/RPO/RTO;
- Authelia/authentik até existir requisito real de SSO/MFA remoto;
- OpenTelemetry/Loki até tracing/log centralizado ser necessário;
- OpenBao até existir operação multi-host de secrets.

## Próximo critério de troca

Nenhum componente acima deve ser trocado por popularidade. Exigir benchmark ou falha objetiva em pelo menos uma destas dimensões: disponibilidade, precisão, segurança, manutenção, licença, consumo local, recoverability ou simplificação arquitetural.
