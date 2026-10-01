# Canonical Entity Import

## Objetivo

Separar o domínio do WhatsApp AI dos formatos de distribuição de cada fonte oficial.

Fontes externas são convertidas para `CANONICAL_ENTITY_NDJSON_V1`; o importador valida cada linha com Zod e grava `canonical_entities` global.

## Formato

Uma entidade por linha:

```json
{"entityId":"carrier:antt:12345678","entityType":"CARRIER","canonicalName":"Transportadora Exemplo","aliases":["Transportadora Exemplo Ltda"],"externalIds":{"rntrc":"12345678","cnpj":"AB1234560001CD"},"confidence":1,"source":{"sourceId":"ANTT_RNTRC","sourceName":"ANTT RNTRC","referenceDate":"2026-08-31","publicationDate":"2026-09-06","license":"CC BY"}}
```

Campos:
- `entityId`: estável e source-scoped;
- `entityType`: CITY, COMPANY, FARM, WAREHOUSE, TERMINAL, CARRIER ou PRODUCT;
- `canonicalName`;
- `aliases`;
- `externalIds`: sempre strings;
- `confidence`: confiança da identidade normalizada;
- `source`: provenance.

## Identificadores

Nunca converter CNPJ, RNTRC, códigos externos ou IDs de fonte para number.

CNPJ deve permanecer string, inclusive inscrições alfanuméricas.

## Fontes oficiais prioritárias

### Receita Federal — CNPJ

Usar Cadastro Nacional da Pessoa Jurídica nos Dados Abertos da Receita Federal.

Conversor RFB deve preservar pelo menos:
- CNPJ/partes do identificador conforme layout vigente;
- razão social/nome empresarial;
- nome fantasia quando disponível;
- situação cadastral;
- município/UF;
- CNAE quando útil;
- data de referência/publicação da snapshot.

`entityId` recomendado: `company:rfb:<CNPJ_CANONICO>`.

### ANTT — RNTRC

Usar o Portal de Dados Abertos ANTT/RNTRC.

O dataset vigente inclui campos como:
- nome_transportador;
- numero_rntrc;
- situacao_rntrc;
- cpfcnpjtransportador;
- categoria_transportador;
- municipio;
- uf;
- data_situacao_rntrc.

`entityId` recomendado: `carrier:antt:<RNTRC>`.

## Importação

```bash
npm run data:import:entities -- canonical.ndjson
```

O arquivo é lido por stream, validado e enviado ao PostgreSQL em batches de 500. Reexecução é idempotente por `entityId`.

## Governança

- tenant pode ler catálogo global;
- tenant não pode alterar catálogo global;
- import global exige identidade privilegiada;
- evidence é substituída pela evidência da snapshot mais recente do mesmo entity id;
- importadores específicos de fonte devem viver fora do runtime principal ou no Research/Data pipeline;
- GitHub mirrors nunca substituem fonte oficial.
