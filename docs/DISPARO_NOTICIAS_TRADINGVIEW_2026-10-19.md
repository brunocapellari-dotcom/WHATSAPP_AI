# Notícias — formato de disparo inspirado no TradingView

**Data:** 19/10/2026. **Tipo:** contrato de apresentação e segurança, ainda não é go-live de notícias.

## Decisão de produto

Quando um coletor de notícias autorizado encontrar uma publicação nova, elegível e verificável, o sistema deverá disponibilizá-la em ordem cronológica decrescente no painel com as colunas:

**Tempo | Instrumento | Título | Provedor**

A apresentação acompanha a referência visual fornecida pelo usuário. Tempo é a hora de **publicação da fonte**, exibida em `America/Cuiaba` com data completa; não usar «há 1 hora» na mensagem persistida, pois o texto envelhece. Instrumento pode conter mais de uma commodity/ativo, desde que identificados com evidência. Título e Provedor devem preservar a notícia e o veículo de origem. Cada item fornece também URL de fonte e resumo breve, estritamente factual, sem previsões, análise, editorialização ou fatos inventados.

**WhatsApp não disponibiliza uma tabela nativa com as colunas do TradingView.** Na distribuição por WhatsApp, enviar uma notificação textual por publicação com os mesmos quatro campos, seguida do resumo breve e do link. Um eventual painel web exibirá os campos como linhas de tabela, reutilizando `news_row`. O sistema não deverá enviar screenshot ou imagem gerada da notícia como substituto do link.

## Contrato implementado nesta alteração

- `app/news_delivery_format.py`: modelo `NewsDispatchItem` com provedor, ID de origem, data com fuso, instrumentos, manchete, URL HTTPS e resumo opcional; `news_row` retorna as colunas para UI; `render_news_whatsapp` cria mensagem legível.
- `news_idempotency_key`: chave determinística por fonte e ID da notícia. É uma chave para o futuro armazenamento/outbox, **não** garante deduplicação efetiva até existir restrição `UNIQUE` no banco e transação de registro.
- URL e campos não confiáveis passam por validação e neutralização de formatação.
- O formatador não coleta, não consulta fontes externas, não inventa resumo e não envia mensagem real.

## Fluxo operacional obrigatório antes da ativação

1. Ingestão somente de fonte autorizada e por método permitido; guardar referência e horário real de publicação.
2. Classificar instrumento/commodity com evidência; quando não houver classificação confiável, usar categoria editorial claramente identificada, nunca atribuir soja/milho por suposição.
3. Verificar validade e pertinência. Resumo curto apenas do conteúdo efetivamente acessível e autorizado, sem reproduzir integralmente notícia protegida.
4. Persistir evento, idempotência, estado da entrega e proveniência em armazenamento com isolamento por inquilino.
5. Enfileirar **uma vez por notícia nova** para os destinatários previamente autorizados a receber alertas de notícias (opt-in distinto dos relatórios de fretes). O gatilho é a ingestão validada, não os horários dos relatórios de fretes.
6. Confirmar o ID de envio no provedor. Resposta ambígua requer reconciliação; nunca reenviar cegamente e gerar mensagens duplicadas.
7. Respeitar política anti-spam, bloqueios/revogação de consentimento, limites do canal e termos da plataforma.
8. Homologar recebimento, formatação, deduplicação, permissão, falhas de provedor, reprocessamento e reinício em servidor real.

## Estado

**Implementado nesta alteração:** contrato de dados, formato do painel e texto para WhatsApp, validações e testes automatizados.

**Não implementado:** coletor de notícias, seleção editorial, criação de resumos, banco/outbox específicos de notícias, cadastro de consentimento de notícias e conexão real com um remetente. Portanto, **nenhuma notícia é disparada automaticamente por esta alteração isolada**.

O coletor de fretes e seus relatórios seguem separados e inalterados.
