# WhatsAppProvider

Cada provider declara capabilities e implementa `sendText`, `normalizeInbound`, `health` e opcionalmente `downloadMedia`.

## Meta Cloud — PRIMARY

Preferido para Business AI e caminho oficial padrão. Assinatura `X-Hub-Signature-256` é validada sobre bytes brutos. O default de Graph API é `v26.0` e deve ser atualizado por configuração, nunca espalhado pelo código.

`managedGroups=true` somente quando explicitamente habilitado e suportado pela conta/API. `existingGroups=false` por padrão. O sistema jamais transforma “Groups API existe” em “a API oficial consegue ler qualquer grupo comum existente”.

## WPPConnect — OPTIONAL / ISOLATED

Adapter opcional para cenários autorizados que dependam de WhatsApp Web. O projeto upstream está ativo, mas é LGPL-3.0. Mantê-lo como serviço/adaptador isolado reduz acoplamento técnico e de licença; nenhum código upstream é copiado para este repositório.

Antes de produção: validar versão, licença/termos aplicáveis, login/recovery, armazenamento de sessão, webhook real, download de mídia, reconnect, rate limits, risco de bloqueio, privacidade e manutenção. Nunca usar para contornar restrições da plataforma.

## Baileys — BENCHMARK / CONTINGENCY

WhiskeySockets/Baileys é um candidato forte caso o conector opcional precise ser substituído: é ativo, MIT e baseado em socket, sem navegador completo. Não é adotado em paralelo porque isso duplicaria a função do adapter de WhatsApp Web e moveria para este projeto persistência de sessão, reconnect e compatibilidade de protocolo.

Uma troca WPPConnect → Baileys só ocorre após o mesmo corpus autorizado de grupos/mensagens provar ganho de estabilidade, custo ou governança.

## Evolution API — NOT ADOPTED

É uma plataforma ampla e ativa, mas incorpora várias capacidades que este projeto já possui: provider abstraction, integrações, filas, storage e IA. Adotá-la como dependência central agora criaria uma segunda plataforma dentro da plataforma. Pode ser reavaliada apenas como adapter externo se surgir uma necessidade concreta não atendida pelos providers existentes.

## Provider swap test

Um novo provider passa somente se:

1. o mesmo corpus E2E produzir `RawMessage` equivalente;
2. Business/Freight não precisarem de alteração de domínio;
3. idempotência, mídia, grupos, reconnect e health passarem na Acceptance Matrix;
4. segurança, privacidade, termos/licença e operação forem aprovados;
5. o provider substituído for removido quando não houver motivo comprovado para manter ambos.
