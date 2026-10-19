# Recuperação de histórico de fretes WhatsApp — requisitos e evidências

Data-base: 19/10/2026. **Ainda não implementado como coleta histórica operacional.**

## Resposta sobre acesso ao histórico

A biblioteca WPPConnect expõe rotas GET de consulta por chat, incluindo
`/api/{session}/get-messages/{phone}` com `count`, `direction` e `id`,
além de consultas legadas de mensagens já carregadas.

Documentação oficial:
https://wppconnect.io/swagger/wppconnect-server/

**Uma rota de leitura não prova que o WhatsApp disponibilizará o histórico
anterior ao pareamento.** A cobertura depende da conta, sincronização do
dispositivo, permissões dos grupos, estado da sessão e versão do WPPConnect.
O ambiente do WHATSAPP_AI ainda não foi pareado nem testado com conversas reais.

Outra via possível é exportação de conversa autorizada a partir de uma conta
que já possua mensagens antigas, via função nativa do WhatsApp. Exportar não
inclui necessariamente todos os anexos, mensagens removidas ou períodos.
Nenhuma recuperação automática de mensagens apagadas é prometida.

## Segurança operacional do histórico

1. Consultar somente grupos de fretes explicitamente aprovados, com acesso
   legítimo da conta; recusar chats pessoais, desconhecidos ou fora da lista.
2. Limitar consultas por grupo, janela de datas, tamanho e paginação. Não
   executar coleta indiscriminada ou tentar contornar limitações de acesso.
3. Preservar `published_at` (data original informada pela mensagem) e
   `received_at` (momento em que a coleta efetivamente a obteve) separados.
4. Reutilizar ID original do provedor quando confiável e aplicar deduplicação
   persistente por fonte + ID, sem confundir anúncios similares de
   transportadoras diferentes.
5. O histórico recuperado deve inicialmente entrar em **quarentena editorial
   / modo somente histórico**, separado de anúncios ativos e de disparos
   automáticos. Não transformar mensagens antigas em lotes abertos hoje.
6. Não recalcular ou sobrescrever relatórios antigos já emitidos. Quando uma
   reconstituição histórica for solicitada, produzir edição/versão auditável e
   distingui-la do retrato conhecido na época (evitar look-ahead bias).
7. Documentar período recuperado, número de registros, lacunas de cobertura,
   mensagens rejeitadas, origem e falhas de coleta; ausência de registros
   não significa ausência de ofertas de frete.
8. Preservar política de não calcular **média municipal de fretes**; valores
   permanecem anúncios separados por transportadora/ponto de embarque/rota/
   produto/equipamento/regime. Maior anúncio da mesma transportadora e
   mesmas condições pode constar do consolidado, preservando valores menores
   no histórico, sem supor que o maior é cronologicamente mais recente.
9. Manter dados pessoais, exportações, números, chaves, tokens e QR fora do
   GitHub, CI e logs. Armazenamento de produção cifrado, com RLS por tenant,
   retenção determinada e autorização comprovada.

## Entrega técnica imediata

`app/history_preview.py` e `tests/test_history_preview.py` permitem
auditar em memória uma página de mensagens **já obtida por meio autorizado**,
sem conectar ao provedor, sem registrar dados privados no disco, sem banco,
sem envio de mensagens e sem alterar a situação dos lotes ativos.

A prévia aceita apenas grupo aprovado, IDs e datas explícitos,
limita a quantidade de registros por página, preserva horários originais,
ignora duplicatas e conteúdo sem texto e retorna somente contagens e hashes
dos registros selecionados. **Não prova integridade nem completude do histórico.**

## Gates restantes

- Disponibilizar servidor e parear número dedicado via QR em sessão privada.
- Homologar os endpoints de leitura **na versão fixada do WPPConnect**
  (o Swagger oficial descreve a API geral, não comprova a versão implantada).
- Verificar pelo menos um grupo autorizado com mensagens anteriores ao QR,
  conferindo primeiro/último horário e duplicação entre páginas.
- Desenvolver adaptador paginado com limites, credenciais segregadas,
  identificadores canônicos e armazenamento histórico isolado.
- Validar exportação manual autorizada para lacunas anteriores ao pareamento.
- Comprovar reconciliação e emissão histórica sem reabrir lotes nem afetar
  as três janelas do relatório operacional.
- Somente depois habilitar coleta histórica em servidor.

**Até esses gates serem cumpridos, não afirmar que o coletor recupera
automaticamente histórico de conversas antigas.**
