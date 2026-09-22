import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;

run('collector reconciliation schema', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const tenantId = 'collector-reconcile-' + randomUUID();
  const collectorId = 'collector-' + randomUUID();

  afterAll(async () => {
    await pool.query('DELETE FROM collectors WHERE collector_id=$1', [collectorId]);
    await pool.query('DELETE FROM tenants WHERE tenant_id=$1', [tenantId]);
    await pool.end();
  });

  it('accepts the reconciliation source type used by WPP polling', async () => {
    await pool.query(
      'INSERT INTO tenants(tenant_id,name) VALUES($1,$2)',
      [tenantId, 'Collector reconciliation test'],
    );

    await expect(pool.query(
      `INSERT INTO collectors(
        collector_id,tenant_id,provider,account,source_type,purpose,status,version
      ) VALUES($1,$2,'wppconnect','default','reconciliation','FREIGHT_INTELLIGENCE','HEALTHY','test')`,
      [collectorId, tenantId],
    )).resolves.toMatchObject({ rowCount: 1 });

    const row = await pool.query(
      'SELECT source_type FROM collectors WHERE collector_id=$1',
      [collectorId],
    );
    expect(row.rows[0]?.source_type).toBe('reconciliation');
  });
});
