import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresCollectorResolver } from '../../src/infra/collectors.js';

const databaseUrl = process.env.DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;

run('collector registry health', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const resolver = new PostgresCollectorResolver(pool);

  afterAll(async () => {
    await pool.end();
  });

  it('moves collector from degraded to healthy and persists latency/message time', async () => {
    const tenantId = `collector-${randomUUID()}`;
    const collectorId = `collector-${randomUUID()}`;
    const lastMessage = new Date('2026-09-18T12:00:00.000Z');

    await pool.query(`INSERT INTO tenants(tenant_id,name) VALUES($1,$2)`, [tenantId, 'Collector Health Test']);
    await pool.query(
      `INSERT INTO collectors(
        collector_id,tenant_id,provider,account,source_type,purpose,status,version
      ) VALUES($1,$2,'meta-cloud','acct','webhook','FREIGHT_INTELLIGENCE','HEALTHY','test')`,
      [collectorId, tenantId],
    );

    try {
      await resolver.recordFailure(collectorId, 321, 'temporary provider error');
      let row = (await pool.query(
        `SELECT status,last_failure,latency_ms,health FROM collectors WHERE collector_id=$1`,
        [collectorId],
      )).rows[0];

      expect(row.status).toBe('DEGRADED');
      expect(row.last_failure).toBeTruthy();
      expect(row.latency_ms).toBe(321);
      expect(row.health.last_error).toContain('temporary provider error');

      await resolver.recordSuccess(collectorId, 42, lastMessage);
      row = (await pool.query(
        `SELECT status,last_success,last_message,latency_ms,health FROM collectors WHERE collector_id=$1`,
        [collectorId],
      )).rows[0];

      expect(row.status).toBe('HEALTHY');
      expect(row.last_success).toBeTruthy();
      expect(new Date(row.last_message).toISOString()).toBe(lastMessage.toISOString());
      expect(row.latency_ms).toBe(42);
      expect(row.health.last_error).toBeUndefined();
    } finally {
      await pool.query(`DELETE FROM collectors WHERE collector_id=$1`, [collectorId]);
      await pool.query(`DELETE FROM tenants WHERE tenant_id=$1`, [tenantId]);
    }
  });
});
