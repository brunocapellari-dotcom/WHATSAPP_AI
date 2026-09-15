import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { withTenant } from '../../src/infra/tenant-db.js';

const databaseUrl = process.env.DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;

run('PostgreSQL tenant isolation', () => {
  const admin = new Pool({ connectionString: databaseUrl });
  let app: Pool;
  const role = 'whatsapp_ai_rls_test';
  const password = 'rls_test_only_password';

  beforeAll(async () => {
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS; END IF; END $$;`);
    await admin.query(`ALTER ROLE ${role} PASSWORD '${password}'`);
    await admin.query(`GRANT CONNECT ON DATABASE ${new URL(databaseUrl!).pathname.slice(1)} TO ${role}`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    await admin.query(`INSERT INTO tenants(tenant_id,name) VALUES('tenant-a','Tenant A'),('tenant-b','Tenant B') ON CONFLICT DO NOTHING`);
    const url = new URL(databaseUrl!);
    url.username = role;
    url.password = password;
    app = new Pool({ connectionString: url.toString() });
  });

  afterAll(async () => { await app?.end(); await admin.end(); });

  it('hides tenant rows without context and across tenant contexts', async () => {
    const id = randomUUID();
    await withTenant(app, 'tenant-a', (client) => client.query(
      `INSERT INTO leads(lead_id,tenant_id,name,status) VALUES($1,'tenant-a','Lead A','OPEN')`, [id],
    ));
    const noContext = await app.query(`SELECT lead_id FROM leads WHERE lead_id=$1`, [id]);
    expect(noContext.rowCount).toBe(0);
    const own = await withTenant(app, 'tenant-a', (client) => client.query(`SELECT lead_id FROM leads WHERE lead_id=$1`, [id]));
    expect(own.rowCount).toBe(1);
    const other = await withTenant(app, 'tenant-b', (client) => client.query(`SELECT lead_id FROM leads WHERE lead_id=$1`, [id]));
    expect(other.rowCount).toBe(0);

    const outboxId = randomUUID();
    await withTenant(app, 'tenant-a', (client) => client.query(
      `INSERT INTO outbox_events(outbox_id,tenant_id,topic,aggregate_id,idempotency_key,payload) VALUES($1,'tenant-a','test.event','agg-1',$2,'{}'::jsonb)`,
      [outboxId, `idem-${outboxId}`],
    ));
    const outboxOther = await withTenant(app, 'tenant-b', (client) => client.query(`SELECT outbox_id FROM outbox_events WHERE outbox_id=$1`, [outboxId]));
    expect(outboxOther.rowCount).toBe(0);
  });
});
