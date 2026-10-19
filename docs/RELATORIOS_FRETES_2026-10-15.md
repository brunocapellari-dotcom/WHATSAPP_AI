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

## Estado do desenvolvimento nesta branch — revisão de 19/10/2026

**Construído e testado em código (ainda sem homologação com WhatsApp real):**

- Extração de múltiplas ofertas e normalização municipal conforme dados IBGE.
- Persistência de observações, separação por transportadora, deduplicação de
  registros e reconciliação conservadora de lotes.
- Dois relatórios, snapshots imutáveis, geração de PDF/XLSX, agendador de
  três horários em Mato Grosso, fila de distribuição com consentimento.
- Eventos brutos cifrados, escopo tenant, fila resistente a reenvios e
  controles de saúde do coletor.
- Prévia da coleta histórica e auditoria local de exportação de conversas
  autorizadas em TXT, sem promover mensagens antigas a anúncios atuais.
- Replay operacional com processamento de cada observação no primeiro
  fechamento elegível, histórico limitado a 365 dias e exclusão de mensagens
  recuperadas mais de 24 horas após seu primeiro fechamento elegível.
  Publicações fora de ordem não prolongam validade de ofertas.
- Testes unitários e integração PostgreSQL no CI do GitHub.

**Pendências de homologação e go-live:**

1. Servidor 24 horas, dentro de limite Always Free comprovado e com backup
   externo seguro; compatibilidade ARM64 do WPPConnect com QR e reinicialização.
2. Aprovação explícita de grupos de frete autorizados, pareamento do número
   dedicado e prova de recebimento real em sessões autorizadas.
3. Homologar funcionamento contínuo, filas e relatórios de três fechamentos
   reais, com mensagens multioferta, valores de transportadoras separadas
   e contagem de lotes consistente.
4. Homologar PDF/XLSX e envio de teste somente a destinatários consentidos,
   com reconhecimento de entrega e prevenção de duplicatas.
5. Restaurar backup cifrado em ambiente isolado e provar recuperação após
   queda de serviço ou reinicialização.
6. Para histórico anterior ao pareamento: testar se WPPConnect realmente
   expõe mensagens antigas na versão implantada; exportações TXT serão
   auditadas separadamente e não ingressam automaticamente no banco ativo.
7. Integração com piso ANTT somente após dados técnicos e parâmetros
   históricos suficientes; não inventar comparações.

**Limites:** deduplicação inferida sem ID inequívoco não comprova quantidade
física de cargas; ausência de anúncios não prova falta de ofertas quando
a fonte esteve indisponível. Valores são anúncios, não operações concluídas.
Não calcular média municipal de fretes.

**Segurança e custos:** não implantar sem homologação; não ativar serviços
pagos; não colocar números, QR, tokens, chaves ou mensagens privadas no GitHub.
O PR #18 permanece em validação, não se trata de go-live real.
