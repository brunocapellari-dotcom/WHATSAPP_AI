import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  importGlobalCanonicalEntityBatch,
  normalizeCanonicalImport,
} from '../../src/freight/canonical-import.js';
import { PostgresEntityResolver } from '../../src/freight/entity-resolution.js';

const databaseUrl = process.env.DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;

run('canonical entity import', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const entityIds: string[] = [];

  afterAll(async () => {
    if (entityIds.length > 0) {
      await pool.query(
        'DELETE FROM canonical_entities WHERE entity_id = ANY($1::text[])',
        [entityIds],
      );
    }
    await pool.end();
  });

  it('normalizes aliases while preserving textual external identifiers and provenance', () => {
    const row = normalizeCanonicalImport({
      entityId: 'company:rfb:AB1234560001CD',
      entityType: 'COMPANY',
      canonicalName: 'Companhia São José Ltda',
      aliases: ['Cia. São José', 'COMPANHIA SAO JOSE LTDA'],
      externalIds: { cnpj: 'AB1234560001CD' },
      confidence: 1,
      source: {
        sourceId: 'RFB_CNPJ',
        sourceName: 'Receita Federal CNPJ',
        referenceDate: '2026-09-01',
      },
    });

    expect(row.externalIds.cnpj).toBe('AB1234560001CD');
    expect(row.aliases).toContain('COMPANHIA SAO JOSE LTDA');
    expect(row.aliases).toContain('CIA SAO JOSE');
  });

  it('imports global companies/carriers and resolves them through the shared catalog', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const companyId = `company:rfb:AB${suffix}`;
    const carrierId = `carrier:antt:RNTRC${suffix}`;
    entityIds.push(companyId, carrierId);

    const imported = await importGlobalCanonicalEntityBatch(pool, [
      {
        entityId: companyId,
        entityType: 'COMPANY',
        canonicalName: 'Transportes São Lucas S.A.',
        aliases: ['Transportes Sao Lucas', 'Sao Lucas Transportes'],
        externalIds: { cnpj: `AB${suffix}` },
        source: {
          sourceId: 'RFB_CNPJ',
          sourceName: 'Receita Federal CNPJ',
          referenceDate: '2026-09-01',
          publicationDate: '2026-09-10',
        },
      },
      {
        entityId: carrierId,
        entityType: 'CARRIER',
        canonicalName: 'Transportadora Horizonte',
        aliases: ['Horizonte Transportes'],
        externalIds: { rntrc: `RNTRC${suffix}` },
        source: {
          sourceId: 'ANTT_RNTRC',
          sourceName: 'ANTT RNTRC',
          referenceDate: '2026-09-01',
        },
      },
    ]);

    expect(imported).toBe(2);

    const resolver = new PostgresEntityResolver(pool);
    expect(await resolver.resolveCompany('Sao Lucas Transportes')).toEqual({
      id: companyId,
      canonicalName: 'Transportes São Lucas S.A.',
    });
    expect(await resolver.resolveCompany('Horizonte Transportes')).toEqual({
      id: carrierId,
      canonicalName: 'Transportadora Horizonte',
    });

    const evidence = await pool.query(
      'SELECT external_ids,evidence FROM canonical_entities WHERE entity_id=$1',
      [companyId],
    );
    expect(evidence.rows[0].external_ids).toMatchObject({ cnpj: `AB${suffix}` });
    expect(evidence.rows[0].evidence[0]).toMatchObject({
      sourceId: 'RFB_CNPJ',
      importFormat: 'CANONICAL_ENTITY_NDJSON_V1',
    });
  });

  it('upserts a global entity deterministically without creating duplicates', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const entityId = `company:rfb:UP${suffix}`;
    entityIds.push(entityId);

    const base = {
      entityId,
      entityType: 'COMPANY' as const,
      canonicalName: 'Empresa Original',
      aliases: ['Empresa Original'],
      externalIds: { cnpj: `UP${suffix}` },
      source: {
        sourceId: 'RFB_CNPJ',
        sourceName: 'Receita Federal CNPJ',
      },
    };

    expect(await importGlobalCanonicalEntityBatch(pool, [base])).toBe(1);
    expect(await importGlobalCanonicalEntityBatch(pool, [{
      ...base,
      canonicalName: 'Empresa Atualizada',
      aliases: ['Empresa Atualizada'],
    }])).toBe(1);

    const rows = await pool.query(
      'SELECT canonical_name FROM canonical_entities WHERE entity_id=$1',
      [entityId],
    );
    expect(rows.rows).toEqual([{ canonical_name: 'Empresa Atualizada' }]);
  });
});
