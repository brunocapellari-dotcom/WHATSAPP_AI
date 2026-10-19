# Fontes e assuntos — WhatsApp AI

Data: 19/10/2026. Este cadastro ainda não foi aprovado para ativação.

## Como cadastrar

A lista de temas é exemplificada em config/news_collection.example.json.
O cadastro de fontes está vazio por padrão: não há conexões até o usuário
especificar quais portais, links RSS e assuntos autoriza.

Para cada fonte acrescentar um objeto com os campos:

- source_id: identificador exclusivo.
- provider: nome da fonte.
- feed_url: HTTPS completo do feed RSS ou Atom autorizado.
- allowed_topic_ids: lista de assuntos permitidos para esta fonte.
- enabled: true após validação da fonte, disponibilidade e autorização.

Os temas possuem include_terms e exclude_terms. Um título/descrição de feed
que contenha expressão permitida e nenhuma proibida poderá ser selecionado,
sempre dentro da fonte e de seus temas declarados.

## Verificação única

Executar somente após configurar a lista localmente:

    python -m scripts.collect_news_once --config config/news_collection.local.json

Esse comando coleta uma única vez e produz candidatos em JSON Lines. Não
envia WhatsApp, não executa em segundo plano e não armazena a notícia
permanentemente. Repetir o comando pode produzir a mesma publicação; o
controle de duplicatas persistente ainda exige banco e fila transacional.

RSS e Atom têm XML protegido contra entidades externas, limite de 1 MB por
resposta, até 100 itens, HTTPS, URL de feed fixa e redirecionamento proibido.
Isso não elimina a necessidade de regras de saída de rede na infraestrutura
para bloquear DNS rebinding ou conexões indevidas.

## Gates para produção

- Confirmar as fontes específicas e regras de uso, licença e frequência.
- Validar feed oficial ou API; fontes sem RSS exigem adaptador autorizado.
- Exigir data e URL originais da notícia e filtro por assunto.
- Incluir resumo breve gerado a partir de conteúdo efetivamente acessível,
  sem inventar fatos nem copiar matérias protegidas integralmente.
- Criar persistência durável, reprocessamento, deduplicação e RLS por tenant.
- Configurar opt-in de destinatários específico para notícias e cancelamento.
- Homologar envio WhatsApp, confirmação e comportamento após quedas da coleta.
- Manter relatório de fretes separado da distribuição de notícias.

Não associar, ativar nem fazer requisições a qualquer fonte antes de sua
aprovação. A nova implementação não é um serviço 24 horas em produção.

## Assuntos aprovados em 19/10/2026

O usuário definiu estes assuntos para a coleta, independente do cadastro das
fontes: política/geopolítica com vínculo ao preço das commodities, combustíveis,
produção e custos produtivos; safra de soja, milho e algodão; boi gordo e
bezerro; meteorologia e previsão do tempo.

O arquivo config/news_collection.example.json contém dez classificações:
politica_geopolitica, safra_soja, safra_milho, safra_algodao, boi_gordo,
bezerro, combustiveis, custos_producao, meteorologia e previsao_tempo.

Para política/geopolítica não basta mencionar um evento político. O filtro
exige simultaneamente: (1) um termo político/geopolítico explícito, (2) vínculo
textual com commodity, agro, energia, câmbio, insumos ou logística, e (3) termo
explícito de preço, produção, oferta, demanda, custo ou outra consequência de
mercado. Para safras é obrigatória a coocorrência de cultura e termo de
plantio, colheita, produção, produtividade, lavoura ou relatório de safra.

**Limite metodológico:** coocorrência textual não comprova relação de
causalidade. O filtro é apenas seleção preliminar: um controle editorial
posterior deve rejeitar notícias que citem termos sem descrever uma ligação
material plausível. Não atribuir impacto não informado pela fonte.

Meteorologia e previsão do tempo são editorias distintas; notícias
meteorológicas não constituem previsões meteorológicas próprias. Não gerar
previsões ou valores sem origem e data de validade declaradas.

Nenhum provedor foi ativado: sources permanece vazio. As fontes, condições de
uso e destinatários para a distribuição ainda precisam ser definidos. O
monitoramento permanece separado dos relatórios de fretes.
