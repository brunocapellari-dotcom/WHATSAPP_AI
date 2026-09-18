import type { Pool } from 'pg';
import type { EntityResolver } from '../domain/ports.js';
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
  async resolveCity(value: string | null, _tenantId?: string) {
    if (!value) return null;
    const normalized = normalizeEntityText(value);
    const canonicalName = cityAliases[normalized] ?? normalized;
    return {
      id: `city:unverified:${sha256(canonicalName).slice(0, 16)}`,
      canonicalName,
    };
  }

  async resolveCompany(value: string | null, _tenantId?: string) {
    if (!value) return null;
    const canonicalName = normalizeEntityText(value)
      .replace(/\b(?:LTDA|S A|SA|EIRELI)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      id: `company:unverified:${sha256(canonicalName).slice(0, 16)}`,
      canonicalName,
    };
  }

  async resolveProduct(value: string | null, _tenantId?: string) {
    if (!value) return null;
    const normalized = normalizeEntityText(value);
    const canonicalName = productAliases[normalized] ?? normalized;
    return {
      id: `product:unverified:${sha256(canonicalName).slice(0, 16)}`,
      canonicalName,
    };
  }
}

type CatalogEntityType = 'CITY' | 'COMPANY' | 'CARRIER' | 'PRODUCT';

type CatalogRow = {
  entity_id: string;
  canonical_name: string;
  tenant_id: string | null;
  confidence: string | number;
};

export class PostgresEntityResolver implements EntityResolver {
  private readonly fallback = new CanonicalEntityResolver();

  constructor(private readonly pool: Pool) {}

  async resolveCity(value: string | null, tenantId?: string) {
    const catalog = await this.resolveFromCatalog('CITY', value, tenantId);
    return catalog ?? this.fallback.resolveCity(value, tenantId);
  }

  async resolveCompany(value: string | null, tenantId?: string) {
    const catalog = await this.resolveFromCatalog('COMPANY', value, tenantId)
      ?? await this.resolveFromCatalog('CARRIER', value, tenantId);
    return catalog ?? this.fallback.resolveCompany(value, tenantId);
  }

  async resolveProduct(value: string | null, tenantId?: string) {
    const catalog = await this.resolveFromCatalog('PRODUCT', value, tenantId);
    return catalog ?? this.fallback.resolveProduct(value, tenantId);
  }

  private async resolveFromCatalog(
    entityType: CatalogEntityType,
    value: string | null,
    tenantId?: string,
  ): Promise<{ id: string; canonicalName: string } | null> {
    if (!value) return null;
    const alias = normalizeEntityText(value);
    if (!alias) return null;

    const sql = `SELECT entity_id,canonical_name,tenant_id,confidence
       FROM canonical_entities
       WHERE entity_type=$1
         AND (tenant_id IS NULL OR tenant_id=$2)
         AND aliases @> ARRAY[$3]::text[]
       ORDER BY (tenant_id IS NOT NULL) DESC, confidence DESC, canonical_name
       LIMIT 4`;
    const values = [entityType, tenantId ?? null, alias];

    const result = tenantId
      ? await tenantQuery<CatalogRow>(this.pool, tenantId, sql, values)
      : await this.pool.query<CatalogRow>(sql, values);

    if (result.rows.length === 0) return null;

    const tenantRows = tenantId
      ? result.rows.filter((row) => row.tenant_id === tenantId)
      : [];
    const candidates = tenantRows.length > 0 ? tenantRows : result.rows;

    const uniqueIds = new Set(candidates.map((row) => row.entity_id));
    if (uniqueIds.size !== 1) return null;

    const row = candidates[0];
    if (!row) return null;
    return { id: row.entity_id, canonicalName: row.canonical_name };
  }
}
