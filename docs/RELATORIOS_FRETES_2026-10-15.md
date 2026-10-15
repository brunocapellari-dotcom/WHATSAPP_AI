# Relatórios de fretes — contrato operacional (2026-10-15)

**Escopo:** WhatsApp AI é independente do NIVON. Especificação e primeira
implementação de cálculos na branch de relatórios. **Não é go-live**.

## Produtos

### Relatório completo

Três publicações diárias no fuso America/Cuiaba:

| Publicação | Janela de publicações no WhatsApp |
| --- | --- |
| 08:30 | 00:00–07:59:59.999999 |
| 14:00 | 08:00–13:29:59.999999 |
| 17:00 | 13:30–16:29:59.999999 |

Publicações das 16:30 às 23:59:59 entram no relatório das 08:30 do
dia seguinte como remanescentes do fechamento anterior. Evitar sobreposição
e contagem dupla em 13:30 ou 16:30.

Cada oferta comercial por transportadora permanece no boletim até a terceira
publicação consecutiva **sem reconfirmação** após a última observação. Se o
coletor apresentar falha de cobertura, não consumir uma ausência. Encerrar por
ausência não comprova o cancelamento físico da carga.

O relatório completo contém transportadoras individuais, origem, fazenda,
destino, produto, último frete, reajustes R$ e %, lista de ofertas ativas e
consolidação de ofertas por município de origem e transportadora. A mudança
de preço de uma transportadora não modifica o registro das concorrentes.

A comparação com ANTT depende de distância, classificação de carga,
operação, eixos e normas/coeficientes históricos validados. **Não implementar
piso inventado ou comparação ilegal sem parâmetros suficientes.**

### Relatório simplificado

Filtra **somente origens em MT**. Destinos de qualquer UF do Brasil.

Tabela principal de duas colunas, sem quantidade de lotes por linha:

| Origem → Destino | Frete |
| --- | ---: |
| Sorriso (Faz. Gaspar) → Rondonópolis | R$ 170–180/t |

No final, necessariamente:
- total de lotes abertos;
- totalizador por município de origem (somente MT);
- totalizador por município de destino (todas as UFs).

Cada carga/identidade física aparece uma vez no simplificado, mesmo que
20 transportadoras publiquem 20 ofertas comerciais do mesmo lote. A oferta
comercial é uma unidade separada para o relatório completo.

Quando não há ID inequívoco da carga, a identidade por fazenda, rota, produto
e período é **inferida, não confirmada**. Duas cargas reais comprovadamente
distintas não podem ser colapsadas. Valor por faixa mínimo–máximo é exibido
apenas quando as unidades comerciais são comparáveis. Unidades diferentes
precisam ficar identificadas, sem conversão arbitrária.

O total de lotes únicos, a soma por origens e a soma por destinos devem
conciliar exatamente.

## Estado do desenvolvimento nesta branch

**Disponível em código, mas ainda não integrado à operação real:**

- app/freight_reporting.py — cortes, variações, ausência após três
  fechamentos, consolidação por transportadora, agrupamento por carga,
  origem MT e totalizadores; gera os dois modelos em Markdown.
- app/freight_multi_parser.py — extrai múltiplas linhas de fretes com
  destino e produto herdados dos cabeçalhos sem inventar município/UF.
- tests/test_freight_reporting.py e tests/test_freight_multi_parser.py —
  cenários de regressão e deduplicação.

**Pendências até publicação automática e go-live:**

1. Integrar multi-extração à API e à ingestão existente, gravando múltiplos
   eventos provenientes de uma mensagem com identificadores idempotentes.
2. Validar nomes de municípios e respectivas UFs com cadastro canônico;
   não presumir MT em cidades de nome ambíguo.
3. Persistir observações, estado de ausências, cobertura e snapshots
   imutáveis no PostgreSQL com controle de acesso por tenant.
4. Corrigir atomicidade de evento, outbox e marcação do evento de origem;
   eliminar dependência de matching por apenas 100 eventos recentes.
5. Implementar agendador robusto, PDF e XLSX do completo e resumo compacto
   do simplificado; garantir reprodução exata de relatório já emitido.
6. Enviar relatórios aos contatos explicitamente autorizados e configurados
   com fila durável, controle de idempotência e confirmação de entrega.
   Testar compatibilidade do método de envio com o WhatsApp.
7. Integrar piso ANTT versionado; homologar o fluxo real ponta a ponta,
   backup/restauração e desempenho sob milhares de linhas.

**Segurança/custos:** não implantar sem validação, não ativar serviços pagos,
não expor segredos, números de telefone, QR ou mensagens privadas no GitHub.
