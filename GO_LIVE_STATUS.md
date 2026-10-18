# SITUAÇÃO DO GO-LIVE — WHATSAPP AI

**Atualização:** 18/10/2026  
**PR de implantação:** #18 (branch `feat/relatorios-fretes-mt-2026-10-15`)  
**Estado:** NÃO está em produção. Não realizar merge ou enviar mensagens reais sem os gates abaixo.

## Meta operacional aprovada

O WhatsApp AI deve coletar informações autorizadas do WhatsApp, preservar evidências,
gerar resumos breves de notícias (sem análise adicional), e produzir relatórios de
fretes de Mato Grosso — completo três vezes ao dia e simplificado com deduplicação
por ponto de carregamento, origem e destino. O WhatsApp AI não depende do NIVON.

**Execução 24 horas na nuvem, mesmo com o notebook desligado, com custo de
implantação e manutenção idealmente zero.** Compose local é ambiente de
homologação, não a arquitetura oficial definitiva. Nenhum recurso pago pode ser
ativado sem autorização expressa.

## Entregas de código já implementadas na branch

- Webhook com HMAC, isolamento de inquilinos, criptografia de dados brutos,
  idempotência por provedor e persistência atômica.
- Extrator de múltiplos registros de frete em uma publicação, com identificação
  de município canônico e preservação do evento original.
- Agendamento dos fechamentos, detecção de falhas de coleta, replay por saúde
  histórica do coletor e snapshots imutáveis, inclusive PDF e XLSX.
- Fila de distribuição condicionada a destinatários **explicitamente autorizados**.
- Envio opt-in para contatos WhatsApp por texto, PDF e XLSX, com confirmação
  individual de partes. Respostas externas incertas exigem revisão humana para
  evitar reenvios potencialmente duplicados.
- Política de rede privada para WPPConnect, sem expor credencial/token ou número
  em logs; serviço de saída desativado por padrão (`REPORT_SENDER_ENABLED=0`)
  e perfil Compose `send` somente por acionamento deliberado.
- CI do GitHub contendo tipagem, lint, Bandit, testes com PostgreSQL e RLS,
  busca de segredos, construção de imagem e varredura de vulnerabilidades.
  Evidência atualizada em cada execução do PR.

## Bloqueios P0: não confundir código com serviço operando

| Gate | Estado em 18/10/2026 | Prova obrigatória |
|---|---|---|
| CI sobre o commit final | Em validação contínua | Todos os jobs verdes no commit de release |
| Servidor 24h com custo aprovado | **PENDENTE DE AÇÃO HUMANA** | VM/conta existente ou instância Always Free confirmada, sem cobranças |
| WPPConnect ARM64, se servidor ARM | NÃO HOMOLOGADO | Build, Chromium, sessão e reinício real na arquitetura escolhida |
| Número WhatsApp dedicado autorizado | **PENDENTE DE AÇÃO HUMANA** | Pareamento QR realizado privadamente |
| Coleta de Canais do WhatsApp | NÃO HOMOLOGADA | Duas publicações reais de Canal identificado, com consentimento e sem método proibido |
| Fontes/grupos autorizados | PENDENTE | Lista de identificadores autorizados e ingestão real |
| Destinatários consentidos | PENDENTE | Registro administrativo de consentimento, telefone/transportes permitidos |
| Token WPP e saída | PENDENTE | Envio autorizado real, confirmação de ID de texto, PDF e XLSX |
| Resumo breve de notícias | NÃO HOMOLOGADO | Testes com mensagens reais, sem fabricar conteúdo nem análise |
| Relatórios MT completos e simplificados | CÓDIGO DISPONÍVEL, NÃO HOMOLOGADO | Dados reais, três horários, lotes deduplicados, totais por origem/destino |
| Backup cifrado e restauração em servidor | PENDENTE | Restore drill recuperável e evidenciado |
| Segurança operacional da VM | PENDENTE | SSH por chave, rede privada, monitoramento, alertas, restart e recuperação |
| Retomada após falha e E2E | PENDENTE | Coletar → persistir → fechar → enviar em dois ciclos reais |

**Atenção:** serviço baseado em WhatsApp Web não garante acesso irrestrito a
Canais nem substitui validação de autorização e conformidade. Sem prova real
de coleta de Canais, não divulgar essa funcionalidade como operacional.

## Dependência humana mínima

1. Disponibilizar ou aprovar uma máquina 24h no provedor escolhido, com custo
   efetivamente verificado como gratuito (por exemplo, avaliar instância
   ARM64 Always Free antes de assumir disponibilidade ou compatibilidade).
2. Permitir configuração operacional do servidor por acesso seguro sem revelar
   chaves privadas, senhas ou tokens no chat/GitHub.
3. Realizar o pareamento WhatsApp via QR **somente em sessão privada** e
   aprovar as fontes e destinatários reais.

Depois disso, concluir no próprio servidor testes de coleta, autorização,
envio, backup/restauração, observabilidade e rollback. Nenhuma dessas
etapas externas é comprovada apenas pelos testes automatizados.

## Regras de go-live

- Não emitir dados brutos, chaves, tokens, telefones ou QR em logs públicos.
- Não informar como cotações negociadas as **divulgações de transportadoras**.
- Não chamar um anúncio de operação realizada.
- Não aplicar ausência de novas mensagens como encerramento de lotes quando
  coletor estiver indisponível.
- Não retentar um envio WhatsApp de resultado ambíguo sem reconciliação humana.
- Não declarar GO-LIVE sem P0 zerado e testes ponta a ponta com dados reais.
