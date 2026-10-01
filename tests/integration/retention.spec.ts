import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { QuarantineRetention } from '../../src/infra/retention.js';

const databaseUrl = process.env.DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;

run('quarantine retention', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const retention = new QuarantineRetention(pool);

  afterAll(async () => {
    await pool.end();
  });

  it('deletes expired quarantine rows while preserving future rows', async () => {
    const tenantId = `retention-${randomUUID()}`;
    const expiredId = randomUUID();
    const futureId = randomUUID();
    const now = new Date('2026-09-16T12:00:00.000Z');

    await pool.query(`INSERT INTO tenants(tenant_id,name) VALUES($1,$2)`, [tenantId, 'Retention Test']);
    await pool.query(
      `INSERT INTO quarantine_messages(
        quarantine_id,tenant_id,provider,provider_message_id,encrypted_payload,content_hash,expires_at
      ) VALUES
        ($1,$3,'mock',$4,'expired','hash-expired',$6),
        ($2,$3,'mock',$5,'future','hash-future',$7)`,
      [
        expiredId,
        futureId,
        tenantId,
        `expired-${expiredId}`,
        `future-${futureId}`,
        new Date(now.getTime() - 1_000),
        new Date(now.getTime() + 60_000),
      ],
    );

    try {
      const deleted = await retention.purgeExpired(now);
      expect(deleted).toBeGreaterThanOrEqual(1);

      const expired = await pool.query(`SELECT quarantine_id FROM quarantine_messages WHERE quarantine_id=$1`, [expiredId]);
      const future = await pool.query(`SELECT quarantine_id FROM quarantine_messages WHERE quarantine_id=$1`, [futureId]);
      expect(expired.rowCount).toBe(0);
      expect(future.rowCount).toBe(1);
    } finally {
      await pool.query(`DELETE FROM quarantine_messages WHERE tenant_id=$1`, [tenantId]);
      await pool.query(`DELETE FROM tenants WHERE tenant_id=$1`, [tenantId]);
    }
  });
});
