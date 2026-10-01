# WhatsAppProvider

Cada provider declara capabilities e implementa `sendText`, `normalizeInbound`, `health` e, quando aplicável, mídia e reconciliação.

## WPPConnect — ZERO-COST / EXISTING-GROUP PATH

WPPConnect Server 2.10.27 é o provider self-hosted adotado para cenários autorizados que dependem de WhatsApp Web e grupos já existentes.

O caminho canônico de ingestão não depende do webhook upstream: o worker une `all-new-messages` e `all-unread-messages`, persiste cada payload no `webhook_inbox` e somente depois marca o chat como visto. Repetições são deduplicadas por message id.

Webhook direto permanece opcional e só é aceito pelo WhatsApp AI com HMAC. Como o WPPConnect Server não assina webhook nativamente, esse modo exige signing proxy confiável; a configuração padrão usa reconciliação.

WPPConnect Server declara Apache-2.0; a biblioteca interna `@wppconnect-team/wppconnect` declara LGPL-3.0-or-later. A separação em container externo deve ser preservada.

Uso deve respeitar acesso autorizado, termos aplicáveis e risco operacional. O projeto não implementa mecanismos para contornar restrições da plataforma.

## Meta Cloud — OPTIONAL / DISABLED IN ZERO-COST

O adapter oficial permanece disponível para cenários em que o proprietário decidir usar a plataforma oficial e aceitar sua política de cobrança.

`ZERO_COST_MODE=true` rejeita credenciais de envio Meta na inicialização.

A assinatura `X-Hub-Signature-256` é validada sobre os bytes brutos. `managedGroups` e `existingGroups` são capacidades distintas; o sistema nunca interpreta suporte a Groups API como acesso geral a grupos comuns preexistentes.

## Baileys — BENCHMARK / CONTINGENCY

Baileys continua referência técnica, mas a release 7 mais recente avaliada permanece RC. Adotá-lo exigiria trazer sessão, reconnect, health e API para dentro deste repositório, duplicando responsabilidade já atendida pelo WPPConnect Server.

Troca só ocorre após benchmark no mesmo corpus autorizado e melhora comprovada.

## whatsapp-web.js — NOT ADOPTED

Ativo e maduro, mas exige browser/session orchestration. Não demonstrou ganho frente ao provider atual.

## Evolution API — NOT ADOPTED AS CORE

É uma plataforma ampla que sobrepõe provider abstraction, automação, integrações e IA já pertencentes ao WhatsApp AI. Sua adoção criaria uma segunda plataforma e maior superfície de licença/operação.

## Provider swap test

Um novo provider só substitui o atual quando:

1. o mesmo corpus E2E produzir `RawMessage` equivalente;
2. Business/Freight não exigirem mudança do domínio;
3. idempotência, mídia, grupos, reconnect/reconciliation e health passarem;
4. segurança, privacidade e licença forem aprovadas;
5. não houver custo obrigatório no caminho canônico;
6. o provider substituído for removido se não houver motivo objetivo para coexistência.
