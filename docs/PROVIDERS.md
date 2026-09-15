# WhatsAppProvider

Cada provider declara capabilities e implementa `sendText`, `normalizeInbound`, `health` e opcionalmente `downloadMedia`.

## Meta Cloud

Preferido para Business AI. Assinatura `X-Hub-Signature-256` é validada sobre bytes brutos. O default de Graph API é `v26.0` e deve ser atualizado por configuração, nunca espalhado pelo código.

`managedGroups=true` somente quando explicitamente habilitado e suportado pela conta/API. `existingGroups=false` por padrão. O sistema jamais transforma “Groups API existe” em “a API oficial consegue ler qualquer grupo comum existente”.

## WPPConnect

Adapter opcional isolado. Antes de produção: validar versão, login/recovery, webhook real, download de mídia, reconnect, rate limits, risco de bloqueio, termos aplicáveis, privacidade e manutenção. Nunca usar para contornar restrições da plataforma.

## Provider swap test

Um novo provider passa somente se o mesmo corpus E2E produzir `RawMessage` equivalente e não exigir alteração nos domínios Business/Freight.
