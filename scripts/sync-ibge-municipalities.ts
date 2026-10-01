import { Pool } from 'pg';
import { loadConfig } from '../src/config.js';
import { normalizeEntityText } from '../src/freight/entity-resolution.js';

const IBGE_MUNICIPALITIES_URL =
  'https://servicodados.ibge.gov.br/api/v1/localidades/municipios?orderBy=nome';

type IbgeUf = { sigla?: string };
type IbgeMunicipality = {
  id?: number;
  nome?: string;
  microrregiao?: { mesorregiao?: { UF?: IbgeUf } };
  'regiao-imediata'?: { 'regiao-intermediaria'?: { UF?: IbgeUf } };
};

function municipalityUf(row: IbgeMunicipality): string | null {
  return row.microrregiao?.mesorregiao?.UF?.sigla
    ?? row['regiao-imediata']?.['regiao-intermediaria']?.UF?.sigla
    ?? null;
}

const config = loadConfig();
const pool = new Pool({
  connectionString: config.MIGRATION_DATABASE_URL ?? config.DATABASE_URL,
  application_name: 'whatsapp-ai-data-sync-ibge',
});

try {
  const response = await fetch(IBGE_MUNICIPALITIES_URL, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`ibge_http_${response.status}`);

  const rows = await response.json() as IbgeMunicipality[];
  if (!Array.isArray(rows) || rows.length < 5_000) {
    throw new Error(`ibge_unexpected_record_count:${Array.isArray(rows) ? rows.length : 'not_array'}`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let imported = 0;

    for (const row of rows) {
      if (!Number.isInteger(row.id) || !row.nome) continue;
      const uf = municipalityUf(row);
      if (!uf) continue;

      const canonicalName = `${row.nome}/${uf}`;
      const aliases = [
        normalizeEntityText(row.nome),
        normalizeEntityText(canonicalName),
      ];

      await client.query(
        `INSERT INTO canonical_entities(
           entity_id,tenant_id,entity_type,canonical_name,external_ids,aliases,evidence,confidence
         ) VALUES($1,NULL,'CITY',$2,$3,$4,$5,1)
         ON CONFLICT(entity_id) DO UPDATE SET
           canonical_name=EXCLUDED.canonical_name,
           external_ids=EXCLUDED.external_ids,
           aliases=EXCLUDED.aliases,
           evidence=EXCLUDED.evidence,
           confidence=1,
           updated_at=now()`,
        [
          `city:ibge:${row.id}`,
          canonicalName,
          { ibgeMunicipalityId: String(row.id), uf },
          [...new Set(aliases)],
          [{
            source: 'IBGE_LOCALIDADES',
            sourceUrl: IBGE_MUNICIPALITIES_URL,
            collectedAt: new Date().toISOString(),
          }],
        ],
      );
      imported++;
    }

    if (imported < 5_000) throw new Error(`ibge_import_too_small:${imported}`);
    await client.query('COMMIT');
    console.log(JSON.stringify({ source: 'IBGE_LOCALIDADES', imported }));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
