import type { Pool } from 'pg';
import { z } from 'zod';
import { normalizeEntityText } from './entity-resolution.js';

export const CanonicalEntityImportSchema = z.object({
  entityId: z.string().min(3).max(200).regex(/^[a-z0-9][a-z0-9:._-]+$/i),
  entityType: z.enum([
    'CITY','COMPANY','FARM','WAREHOUSE','TERMINAL','CARRIER','PRODUCT',
  ]),
  canonicalName: z.string().min(1).max(500),
  aliases: z.array(z.string().min(1).max(500)).max(100).default([]),
  externalIds: z.record(z.string().min(1).max(100), z.string().min(1).max(500)).default({}),
  confidence: z.number().min(0).max(1).default(1),
  source: z.object({
    sourceId: z.string().min(1).max(200),
    sourceName: z.string().min(1).max(300),
    sourceUrl: z.string().url().optional(),
    referenceDate: z.string().date().optional(),
    publicationDate: z.string().date().optional(),
    collectedAt: z.string().datetime().optional(),
    license: z.string().max(200).optional(),
  }),
});

export type CanonicalEntityImport = z.infer<typeof CanonicalEntityImportSchema>;

export function normalizeCanonicalImport(input: unknown): CanonicalEntityImport {
  const parsed = CanonicalEntityImportSchema.parse(input);
  const aliases = new Set<string>();
  aliases.add(normalizeEntityText(parsed.canonicalName));
  for (const alias of parsed.aliases) {
    const normalized = normalizeEntityText(alias);
    if (normalized) aliases.add(normalized);
  }

  return {
    ...parsed,
    aliases: [...aliases].sort(),
    externalIds: Object.fromEntries(
      Object.entries(parsed.externalIds)
        .map(([key, value]) => [key.trim(), value.trim()] as const)
        .filter(([key, value]) => key && value),
    ),
  };
}

export async function importGlobalCanonicalEntityBatch(
  pool: Pool,
  inputs: unknown[],
  options: { importFormat?: string } = {},
): Promise<number> {
  if (inputs.length === 0) return 0;
  if (inputs.length > 1000) throw new Error('canonical_import_batch_too_large');

  const rows = inputs.map(normalizeCanonicalImport);
  const values: unknown[] = [];
  const tuples: string[] = [];

  rows.forEach((row, index) => {
    const offset = index * 7;
    tuples.push(
      `($${offset + 1},NULL,$${offset + 2},$${offset + 3},$${offset + 4}::jsonb,$${offset + 5}::text[],$${offset + 6}::jsonb,$${offset + 7})`,
    );
    values.push(
      row.entityId,
      row.entityType,
      row.canonicalName.trim(),
      JSON.stringify(row.externalIds),
      row.aliases,
      JSON.stringify([{
        ...row.source,
        collectedAt: row.source.collectedAt ?? new Date().toISOString(),
        importFormat: options.importFormat ?? 'CANONICAL_ENTITY_NDJSON_V1',
      }]),
      row.confidence,
    );
  });

  const result = await pool.query(
    `INSERT INTO canonical_entities(
       entity_id,tenant_id,entity_type,canonical_name,external_ids,aliases,evidence,confidence
     ) VALUES ${tuples.join(',')}
     ON CONFLICT(entity_id) DO UPDATE SET
       entity_type=EXCLUDED.entity_type,
       canonical_name=EXCLUDED.canonical_name,
       external_ids=EXCLUDED.external_ids,
       aliases=EXCLUDED.aliases,
       evidence=EXCLUDED.evidence,
       confidence=EXCLUDED.confidence,
       updated_at=now()
     WHERE canonical_entities.tenant_id IS NULL
     RETURNING entity_id`,
    values,
  );

  return result.rowCount ?? 0;
}
