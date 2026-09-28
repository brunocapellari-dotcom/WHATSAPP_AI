import type { Pool } from 'pg';
import type {
  EntityResolver,
  ResolvedEntity,
} from '../domain/ports.js';
import { sha256 } from '../security/crypto.js';
import { tenantQuery } from '../infra/tenant-db.js';

export function normalizeEntityText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const cityAliases: Record<string, string> = {
  ROO: 'RONDONOPOLIS MT',
  RONDONOPOLIS: 'RONDONOPOLIS MT',
  'RONDONOPOLIS MT': 'RONDONOPOLIS MT',
  LRV: 'LUCAS DO RIO VERDE MT',
  'LUCAS DO RIO VERDE': 'LUCAS DO RIO VERDE MT',
  'LUCAS DO RIO VERDE MT': 'LUCAS DO RIO VERDE MT',
  SORRISO: 'SORRISO MT',
  'SORRISO MT': 'SORRISO MT',
  SINOP: 'SINOP MT',
  'SINOP MT': 'SINOP MT',
};

const productAliases: Record<string, string> = {
  SOJA: 'SOJA',
  SOY: 'SOJA',
  MILHO: 'MILHO',
  CORN: 'MILHO',
  'FARELO DE SOJA': 'FARELO DE SOJA',
  FARELO: 'FARELO DE SOJA',
};

export class CanonicalEntityResolver implements EntityResolver {
  async resolveCity(value: string | null): Promise<ResolvedEntity | null> {
    if (!value) return null;
    const normalized = normalizeEntityText(value);
    const known = cityAliases[normalized];
    const canonicalName = known ?? normalized;
    return {
      id: `city:unverified:${sha256(canonicalName).slice(0, 16)}`,
      canonicalName,
      matchMethod: 'FALLBACK',
      confidence: known ? 0.85 : 0.4,
    };
  }

  async resolveCompany(value: string | null): Promise<ResolvedEntity | null> {
    if (!value) return null;
    const canonicalName = normalizeEntityText(value)
      .replace(/\b(?:LTDA|S A|SA|EIRELI)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      id: `company:unverified:${sha256(canonicalName).slice(0, 16)}`,
      canonicalName,
      matchMethod: 'FALLBACK',
      confidence: 0.4,
    };
  }

  async resolveProduct(value: string | null): Promise<ResolvedEntity | null> {
    if (!value) return null;
    const normalized = normalizeEntityText(value);
    const known = productAliases[normalized];
    const canonicalName = known ?? normalized;
    return {
      id: `product:unverified:${sha256(canonicalName).slice(0, 16)}`,
      canonicalName,
      matchMethod: 'FALLBACK',
      confidence: known ? 0.9 : 0.5,
    };
  }
}

type CatalogEntityType = 'CITY' | 'COMPANY' | 'CARRIER' | 'PRODUCT';

type CatalogRow = {
  entity_id: string;
  canonical_name: string;
  tenant_id: string | null;
  confidence: string | number;
  score: string | number;
};

const FUZZY_THRESHOLD: Record<CatalogEntityType, number> = {
  CITY: 0.86,
  COMPANY: 0.9,
  CARRIER: 0.9,
  PRODUCT: 0.92,
};

const AMBIGUITY_MARGIN = 0.06;

function numeric(value: string | number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function scopeRows(rows: CatalogRow[], tenantId?: string): CatalogRow[] {
  if (!tenantId) return rows.filter((row) => row.tenant_id === null);
  const tenantRows = rows.filter((row) => row.tenant_id === tenantId);
  return tenantRows.length > 0
    ? tenantRows
    : rows.filter((row) => row.tenant_id === null);
}

function exactCandidate(
  rows: CatalogRow[],
  tenantId?: string,
): ResolvedEntity | null {
  const scoped = scopeRows(rows, tenantId);
  const unique = new Map(scoped.map((row) => [row.entity_id, row]));
  if (unique.size !== 1) return null;
  const row = [...unique.values()][0];
  if (!row) return null;
  return {
    id: row.entity_id,
    canonicalName: row.canonical_name,
    matchMethod: 'EXACT',
    confidence: Math.max(0, Math.min(1, numeric(row.confidence))),
  };
}

function fuzzyCandidate(
  rows: CatalogRow[],
  tenantId: string | undefined,
  threshold: number,
): ResolvedEntity | null {
  const scoped = scopeRows(rows, tenantId)
    .map((row) => ({
      ...row,
      combined: numeric(row.score) * numeric(row.confidence),
    }))
    .sort((a, b) => b.combined - a.combined);

  const top = scoped[0];
  if (!top || top.combined < threshold) return null;

  const second = scoped.find((row) => row.entity_id !== top.entity_id);
  if (second && top.combined - second.combined < AMBIGUITY_MARGIN) {
    return null;
  }

  return {
    id: top.entity_id,
    canonicalName: top.canonical_name,
    matchMethod: 'FUZZY',
    confidence: Math.max(0, Math.min(1, top.combined)),
  };
}

export class PostgresEntityResolver implements EntityResolver {
  private readonly fallback = new CanonicalEntityResolver();

  constructor(private readonly pool: Pool) {}

  async resolveCity(value: string | null, tenantId?: string) {
    const catalog = await this.resolveFromCatalog('CITY', value, tenantId);
    return catalog ?? this.fallback.resolveCity(value);
  }

  async resolveCompany(value: string | null, tenantId?: string) {
    const catalog = await this.resolveFromCatalog('COMPANY', value, tenantId)
      ?? await this.resolveFromCatalog('CARRIER', value, tenantId);
    return catalog ?? this.fallback.resolveCompany(value);
  }

  async resolveProduct(value: string | null, tenantId?: string) {
    const catalog = await this.resolveFromCatalog('PRODUCT', value, tenantId);
    return catalog ?? this.fallback.resolveProduct(value);
  }

  private async resolveFromCatalog(
    entityType: CatalogEntityType,
    value: string | null,
    tenantId?: string,
  ): Promise<ResolvedEntity | null> {
    if (!value) return null;
    const alias = normalizeEntityText(value);
    if (!alias) return null;

    const exactSql = `SELECT
         e.entity_id,
         e.canonical_name,
         e.tenant_id,
         e.confidence,
         1::float8 AS score
       FROM canonical_entity_aliases a
       JOIN canonical_entities e ON e.entity_id=a.entity_id
       WHERE a.entity_type=$1
         AND (a.tenant_id IS NULL OR a.tenant_id=$2)
         AND a.alias=$3
       ORDER BY (a.tenant_id IS NOT NULL) DESC,e.confidence DESC,e.canonical_name
       LIMIT 8`;
    const values = [entityType, tenantId ?? null, alias];

    const exactResult = tenantId
      ? await tenantQuery<CatalogRow>(this.pool, tenantId, exactSql, values)
      : await this.pool.query<CatalogRow>(exactSql, values);

    const exact = exactCandidate(exactResult.rows, tenantId);
    if (exact) return exact;

    // Short aliases are intentionally exact-only. Trigram similarity is too
    // permissive for abbreviations such as ROO, LRV or short product codes.
    if (alias.length < 5) return null;

    const fuzzySql = `SELECT
         e.entity_id,
         e.canonical_name,
         e.tenant_id,
         e.confidence,
         MAX(similarity(a.alias,$3))::float8 AS score
       FROM canonical_entity_aliases a
       JOIN canonical_entities e ON e.entity_id=a.entity_id
       WHERE a.entity_type=$1
         AND (a.tenant_id IS NULL OR a.tenant_id=$2)
         AND a.alias % $3
       GROUP BY e.entity_id,e.canonical_name,e.tenant_id,e.confidence
       ORDER BY score DESC,e.confidence DESC,e.canonical_name
       LIMIT 8`;

    const fuzzyResult = tenantId
      ? await tenantQuery<CatalogRow>(this.pool, tenantId, fuzzySql, values)
      : await this.pool.query<CatalogRow>(fuzzySql, values);

    return fuzzyCandidate(
      fuzzyResult.rows,
      tenantId,
      FUZZY_THRESHOLD[entityType],
    );
  }
}
