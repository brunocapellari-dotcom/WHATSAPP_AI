import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresEntityResolver } from '../../src/freight/entity-resolution.js';

const databaseUrl = process.env.DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;

run('canonical entity catalog', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const resolver = new PostgresEntityResolver(pool);
  const createdIds: string[] = [];

  afterAll(async () => {
    if (createdIds.length) {
      await pool.query('DELETE FROM canonical_entities WHERE entity_id = ANY($1::text[])', [createdIds]);
    }
    await pool.end();
  });

  it('prefers an official catalog city over fallback aliases', async () => {
    const id = 'city:ibge:test-' + randomUUID();
    createdIds.push(id);
    await pool.query(
      "INSERT INTO canonical_entities(entity_id,entity_type,canonical_name,aliases,external_ids,evidence,confidence) VALUES($1,'CITY','Rondonópolis/MT',$2,$3,$4,1)",
      [
        id,
        ['RONDONOPOLIS', 'RONDONOPOLIS MT'],
        { ibgeMunicipalityId: '5107602', uf: 'MT' },
        [{ source: 'IBGE_LOCALIDADES' }],
      ],
    );

    const resolved = await resolver.resolveCity('Rondonópolis/MT');
    expect(resolved?.id).toBe(id);
    expect(resolved?.canonicalName).toBe('Rondonópolis/MT');
  });

  it('uses conservative trigram matching for clear official-catalog typos', async () => {
    const id = 'city:ibge:test-' + randomUUID();
    createdIds.push(id);
    await pool.query(
      "INSERT INTO canonical_entities(entity_id,entity_type,canonical_name,aliases,external_ids,evidence,confidence) VALUES($1,'CITY','Rondonópolis/MT',$2,$3,$4,1)",
      [
        id,
        ['RONDONOPOLIS MT'],
        { ibgeMunicipalityId: '5107602', uf: 'MT' },
        [{ source: 'IBGE_LOCALIDADES' }],
      ],
    );

    const resolved = await resolver.resolveCity('Rondonopoliss MT');
    expect(resolved?.id).toBe(id);
    expect(resolved?.matchMethod).toBe('FUZZY');
    expect(resolved?.confidence).toBeGreaterThanOrEqual(0.86);
  });

  it('never applies fuzzy matching to short abbreviations', async () => {
    const id = 'city:ibge:test-' + randomUUID();
    createdIds.push(id);
    await pool.query(
      "INSERT INTO canonical_entities(entity_id,entity_type,canonical_name,aliases,confidence) VALUES($1,'CITY','Rio do Oeste/SC',ARRAY['RIO'],1)",
      [id],
    );

    const resolved = await resolver.resolveCity('RII');
    expect(resolved?.id).not.toBe(id);
    expect(resolved?.matchMethod).toBe('FALLBACK');
  });

  it('does not arbitrarily choose between ambiguous municipality aliases', async () => {
    const first = 'city:ibge:test-' + randomUUID();
    const second = 'city:ibge:test-' + randomUUID();
    createdIds.push(first, second);

    await pool.query(
      "INSERT INTO canonical_entities(entity_id,entity_type,canonical_name,aliases,confidence) VALUES ($1,'CITY','Bom Jesus/PI',ARRAY['BOM JESUS'],1), ($2,'CITY','Bom Jesus/SC',ARRAY['BOM JESUS'],1)",
      [first, second],
    );

    const resolved = await resolver.resolveCity('Bom Jesus');
    expect(resolved?.id.startsWith('city:unverified:')).toBe(true);
  });

  it('keeps company and carrier namespaces distinct when aliases are identical', async () => {
    const companyId = 'company:test-' + randomUUID();
    const carrierId = 'carrier:test-' + randomUUID();
    createdIds.push(companyId, carrierId);

    await pool.query(
      `INSERT INTO canonical_entities(
         entity_id,entity_type,canonical_name,aliases,confidence
       ) VALUES
         ($1,'COMPANY','Transportadora Horizonte Trading',ARRAY['HORIZONTE'],1),
         ($2,'CARRIER','Transportadora Horizonte',ARRAY['HORIZONTE'],1)`,
      [companyId, carrierId],
    );

    const company = await resolver.resolveCompany('Horizonte');
    const carrier = await resolver.resolveCarrier('Horizonte');

    expect(company?.id).toBe(companyId);
    expect(company?.matchMethod).toBe('EXACT');
    expect(carrier?.id).toBe(carrierId);
    expect(carrier?.matchMethod).toBe('EXACT');
  });

  it('resolves a unique facility but refuses ambiguous farm/warehouse names', async () => {
    const warehouseId = 'warehouse:test-' + randomUUID();
    const farmId = 'farm:test-' + randomUUID();
    const ambiguousWarehouseId = 'warehouse:test-' + randomUUID();
    createdIds.push(warehouseId, farmId, ambiguousWarehouseId);

    await pool.query(
      `INSERT INTO canonical_entities(
         entity_id,entity_type,canonical_name,aliases,confidence
       ) VALUES
         ($1,'WAREHOUSE','Armazém Santa Luzia',ARRAY['ARMAZEM SANTA LUZIA'],1),
         ($2,'FARM','Fazenda Boa Esperança',ARRAY['BOA ESPERANCA'],1),
         ($3,'WAREHOUSE','Armazém Boa Esperança',ARRAY['BOA ESPERANCA'],1)`,
      [warehouseId, farmId, ambiguousWarehouseId],
    );

    const unique = await resolver.resolveFacility('Armazem Santa Luzia');
    expect(unique?.id).toBe(warehouseId);
    expect(unique?.matchMethod).toBe('EXACT');

    const ambiguous = await resolver.resolveFacility('Boa Esperanca');
    expect(ambiguous?.id.startsWith('facility:unverified:')).toBe(true);
    expect(ambiguous?.matchMethod).toBe('FALLBACK');
  });

  it('prefers tenant-specific company aliases over global aliases', async () => {
    const tenantId = 'tenant-' + randomUUID();
    const globalId = 'company:test-' + randomUUID();
    const tenantEntityId = 'company:test-' + randomUUID();
    createdIds.push(globalId, tenantEntityId);

    await pool.query('INSERT INTO tenants(tenant_id,name) VALUES($1,$2)', [tenantId, 'Entity Tenant']);
    try {
      await pool.query(
        "INSERT INTO canonical_entities(entity_id,tenant_id,entity_type,canonical_name,aliases,confidence) VALUES ($1,NULL,'COMPANY','Acme Global',ARRAY['ACME'],1), ($2,$3,'COMPANY','Acme Tenant',ARRAY['ACME'],1)",
        [globalId, tenantEntityId, tenantId],
      );

      const resolved = await resolver.resolveCompany('Acme', tenantId);
      expect(resolved?.id).toBe(tenantEntityId);
    } finally {
      await pool.query('DELETE FROM canonical_entities WHERE entity_id=$1', [tenantEntityId]);
      const index = createdIds.indexOf(tenantEntityId);
      if (index >= 0) createdIds.splice(index, 1);
      await pool.query('DELETE FROM tenants WHERE tenant_id=$1', [tenantId]);
    }
  });
});
