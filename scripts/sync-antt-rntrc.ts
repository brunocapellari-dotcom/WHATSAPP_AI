import { Pool } from 'pg';
import {
  importGlobalCanonicalEntityBatch,
  type CanonicalEntityImport,
} from '../src/freight/canonical-import.js';
import {
  rntrcRecordToCanonical,
  type AnttRntrcRecord,
  type AnttRntrcSource,
} from '../src/freight/antt-rntrc.js';

const ANTT_BASE_URL = 'https://dados.antt.gov.br';
const RNTRC_PACKAGE_ID = 'b4a055d1-97a2-46f1-9461-cb17fbc6b6b3';
const PAGE_SIZE = 5_000;
const UPSERT_BATCH_SIZE = 500;

type CkanResource = {
  id?: string;
  name?: string;
  format?: string;
  datastore_active?: boolean;
  last_modified?: string;
  created?: string;
};

type PackageShowResponse = {
  success?: boolean;
  result?: { resources?: CkanResource[] };
};

type DatastoreResponse = {
  success?: boolean;
  result?: {
    total?: number;
    records?: AnttRntrcRecord[];
  };
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson<T>(url: string): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'WhatsApp-AI/1.0 canonical-data-sync',
        },
        signal: AbortSignal.timeout(60_000),
      });

      if (response.ok) return await response.json() as T;
      if (response.status !== 429 && response.status < 500) {
        throw new Error(`antt_http_${response.status}`);
      }
      lastError = new Error(`antt_http_${response.status}`);
    } catch (error) {
      lastError = error;
    }

    if (attempt < 4) await sleep(Math.min(10_000, 500 * 2 ** attempt));
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('antt_request_failed');
}

function monthReferenceDate(resourceName: string): string | undefined {
  const months: Record<string, string> = {
    JAN: '01', FEV: '02', MAR: '03', ABR: '04',
    MAI: '05', JUN: '06', JUL: '07', AGO: '08',
    SET: '09', OUT: '10', NOV: '11', DEZ: '12',
  };
  const match = resourceName.toUpperCase().match(
    /\b(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)(\d{2})\b/,
  );
  if (!match) return undefined;
  const month = months[match[1] ?? ''];
  if (!month) return undefined;
  return `20${match[2]}-${month}-01`;
}

function validResourceId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}

async function discoverLatestResource(): Promise<Required<Pick<CkanResource, 'id' | 'name'>> & CkanResource> {
  const override = process.env.ANTT_RNTRC_RESOURCE_ID?.trim();
  if (override) {
    if (!validResourceId(override)) throw new Error('invalid_antt_resource_id');
    return {
      id: override,
      name: process.env.ANTT_RNTRC_RESOURCE_NAME?.trim() || `RNTRC ${override}`,
      format: 'CSV',
      datastore_active: true,
    };
  }

  const url = new URL('/api/3/action/package_show', ANTT_BASE_URL);
  url.searchParams.set('id', RNTRC_PACKAGE_ID);
  const payload = await fetchJson<PackageShowResponse>(url.toString());
  if (!payload.success) throw new Error('antt_package_show_failed');

  const resources = (payload.result?.resources ?? [])
    .filter((resource) =>
      resource.id
      && resource.name
      && resource.datastore_active === true
      && resource.format?.toUpperCase() === 'CSV'
      && /RNTRC/i.test(resource.name)
      && /(?:Jan|Fev|Mar|Abr|Mai|Jun|Jul|Ago|Set|Out|Nov|Dez)\d{2}/i.test(resource.name),
    )
    .sort((a, b) => {
      const aDate = Date.parse(a.last_modified ?? a.created ?? '1970-01-01');
      const bDate = Date.parse(b.last_modified ?? b.created ?? '1970-01-01');
      return bDate - aDate;
    });

  const latest = resources[0];
  if (!latest?.id || !latest.name || !validResourceId(latest.id)) {
    throw new Error('antt_latest_rntrc_resource_not_found');
  }
  return latest as Required<Pick<CkanResource, 'id' | 'name'>> & CkanResource;
}

async function importBatch(
  pool: Pool,
  rows: CanonicalEntityImport[],
): Promise<number> {
  let imported = 0;
  for (let index = 0; index < rows.length; index += UPSERT_BATCH_SIZE) {
    imported += await importGlobalCanonicalEntityBatch(
      pool,
      rows.slice(index, index + UPSERT_BATCH_SIZE),
      { importFormat: 'ANTT_CKAN_DATASTORE_V1' },
    );
  }
  return imported;
}

const connectionString =
  process.env.MIGRATION_DATABASE_URL
  ?? process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('MIGRATION_DATABASE_URL or DATABASE_URL is required');
}

const resource = await discoverLatestResource();
const collectedAt = new Date().toISOString();
const source: AnttRntrcSource = {
  resourceId: resource.id,
  resourceName: resource.name,
  sourceUrl: `${ANTT_BASE_URL}/dataset/rntrc/resource/${resource.id}`,
  ...(monthReferenceDate(resource.name)
    ? { referenceDate: monthReferenceDate(resource.name) }
    : {}),
  ...(resource.last_modified
    ? { publicationDate: resource.last_modified.slice(0, 10) }
    : {}),
  collectedAt,
};

const pool = new Pool({
  connectionString,
  application_name: 'whatsapp-ai-data-sync-antt-rntrc',
  max: 4,
});

const stats = {
  resourceId: resource.id,
  resourceName: resource.name,
  scanned: 0,
  acceptedOrganizations: 0,
  imported: 0,
  skippedInactive: 0,
  skippedIndividuals: 0,
  skippedMissingName: 0,
  skippedMissingRntrc: 0,
  removedStale: 0,
};

try {
  let offset = 0;
  let expectedTotal: number | null = null;

  while (expectedTotal == null || offset < expectedTotal) {
    const url = new URL('/api/3/action/datastore_search', ANTT_BASE_URL);
    url.searchParams.set('resource_id', resource.id);
    url.searchParams.set('limit', String(PAGE_SIZE));
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('include_total', 'true');

    const payload = await fetchJson<DatastoreResponse>(url.toString());
    if (!payload.success) throw new Error('antt_datastore_search_failed');

    const total = Number(payload.result?.total);
    const records = payload.result?.records ?? [];
    if (!Number.isInteger(total) || total < 10_000) {
      throw new Error(`antt_unexpected_total:${String(payload.result?.total)}`);
    }
    if (expectedTotal == null) expectedTotal = total;
    if (total !== expectedTotal) {
      throw new Error(`antt_total_changed_during_sync:${expectedTotal}->${total}`);
    }
    if (records.length === 0 && offset < total) {
      throw new Error(`antt_premature_empty_page:${offset}/${total}`);
    }

    const accepted: CanonicalEntityImport[] = [];
    for (const record of records) {
      stats.scanned++;
      const transformed = rntrcRecordToCanonical(record, source);
      if (transformed.entity) {
        accepted.push(transformed.entity);
        stats.acceptedOrganizations++;
      } else if (transformed.skipReason === 'inactive') {
        stats.skippedInactive++;
      } else if (transformed.skipReason === 'individual') {
        stats.skippedIndividuals++;
      } else if (transformed.skipReason === 'missing_name') {
        stats.skippedMissingName++;
      } else {
        stats.skippedMissingRntrc++;
      }
    }

    stats.imported += await importBatch(pool, accepted);
    offset += records.length;

    if (records.length === 0) break;
  }

  if (expectedTotal == null || stats.scanned !== expectedTotal) {
    throw new Error(
      `antt_sync_incomplete:scanned=${stats.scanned}:expected=${String(expectedTotal)}`,
    );
  }
  if (stats.acceptedOrganizations < 1_000) {
    throw new Error(
      `antt_accepted_organization_count_too_small:${stats.acceptedOrganizations}`,
    );
  }

  // Cleanup only after the entire snapshot succeeded. Interrupted runs leave
  // the prior catalog intact and are safe to resume.
  const currentEvidence = JSON.stringify([{
    sourceId: `ANTT_RNTRC:${resource.id}`,
  }]);
  const cleanup = await pool.query(
    `DELETE FROM canonical_entities
     WHERE entity_type='CARRIER'
       AND tenant_id IS NULL
       AND entity_id LIKE 'carrier:antt:rntrc:%'
       AND NOT (evidence @> $1::jsonb)
     RETURNING entity_id`,
    [currentEvidence],
  );
  stats.removedStale = cleanup.rowCount ?? 0;

  console.log(JSON.stringify({
    source: 'ANTT_RNTRC',
    ...stats,
    collectedAt,
  }));
} finally {
  await pool.end();
}
