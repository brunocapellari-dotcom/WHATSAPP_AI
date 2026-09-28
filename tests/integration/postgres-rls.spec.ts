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

  it('prevents tenant roles from writing to the global canonical catalog', async () => {
    const suffix = randomUUID();
    const globalId = `company:global-write:${suffix}`;

    await expect(withTenant(app, 'tenant-a', (client) => client.query(
      `INSERT INTO canonical_entities(
         entity_id,tenant_id,entity_type,canonical_name,aliases,confidence
       ) VALUES($1,NULL,'COMPANY','Forbidden Global',ARRAY['FORBIDDEN GLOBAL'],1)`,
      [globalId],
    ))).rejects.toThrow();

    const tenantId = `company:tenant-write:${suffix}`;
    await expect(withTenant(app, 'tenant-a', (client) => client.query(
      `INSERT INTO canonical_entities(
         entity_id,tenant_id,entity_type,canonical_name,aliases,confidence
       ) VALUES($1,'tenant-a','COMPANY','Allowed Tenant',ARRAY['ALLOWED TENANT'],1)`,
      [tenantId],
    ))).resolves.toMatchObject({ rowCount: 1 });

    await expect(withTenant(app, 'tenant-a', (client) => client.query(
      `UPDATE canonical_entities
       SET canonical_name='Tampered'
       WHERE entity_id=$1`,
      [globalId],
    ))).resolves.toMatchObject({ rowCount: 0 });

    await admin.query('DELETE FROM canonical_entities WHERE entity_id=$1', [tenantId]);
  });

  it('allows tenants to read global canonical entities but forbids writing the global namespace', async () => {
    const suffix = randomUUID();
    const globalId = `company:global-write-guard:${suffix}`;
    const tenantId = `company:tenant-write:${suffix}`;

    await admin.query(
      `INSERT INTO canonical_entities(entity_id,tenant_id,entity_type,canonical_name,aliases,confidence)
       VALUES($1,NULL,'COMPANY','Global Readable',ARRAY[$2],1)`,
      [globalId, `GLOBAL-${suffix}`],
    );

    try {
      const visible = await withTenant(app, 'tenant-a', (client) => client.query(
        `SELECT entity_id FROM canonical_entities WHERE entity_id=$1`,
        [globalId],
      ));
      expect(visible.rowCount).toBe(1);

      await expect(withTenant(app, 'tenant-a', (client) => client.query(
        `INSERT INTO canonical_entities(
           entity_id,tenant_id,entity_type,canonical_name,aliases,confidence
         ) VALUES($1,NULL,'COMPANY','Tenant Tried Global',ARRAY[$2],1)`,
        [`company:forbidden-global:${suffix}`, `FORBIDDEN-${suffix}`],
      ))).rejects.toThrow();

      await expect(withTenant(app, 'tenant-a', (client) => client.query(
        `UPDATE canonical_entities
         SET canonical_name='Tenant Changed Global'
         WHERE entity_id=$1`,
        [globalId],
      ))).resolves.toMatchObject({ rowCount: 0 });

      await expect(withTenant(app, 'tenant-a', (client) => client.query(
        `INSERT INTO canonical_entities(
           entity_id,tenant_id,entity_type,canonical_name,aliases,confidence
         ) VALUES($1,'tenant-a','COMPANY','Tenant Owned',ARRAY[$2],1)`,
        [tenantId, `TENANT-${suffix}`],
      ))).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await admin.query(
        `DELETE FROM canonical_entities WHERE entity_id = ANY($1::text[])`,
        [[globalId, tenantId, `company:forbidden-global:${suffix}`]],
      );
    }
  });

  it('shares global canonical entities but isolates tenant-specific aliases', async () => {
    const suffix = randomUUID();
    const globalId = `company:global:${suffix}`;
    const tenantAId = `company:tenant-a:${suffix}`;
    const tenantBId = `company:tenant-b:${suffix}`;

    await admin.query(
      `INSERT INTO canonical_entities(entity_id,tenant_id,entity_type,canonical_name,aliases,confidence)
       VALUES
         ($1,NULL,'COMPANY','Global Entity',ARRAY[$4],1),
         ($2,'tenant-a','COMPANY','Tenant A Entity',ARRAY[$4],1),
         ($3,'tenant-b','COMPANY','Tenant B Entity',ARRAY[$4],1)`,
      [globalId, tenantAId, tenantBId, `RLS-ALIAS-${suffix}`],
    );

    try {
      const noContext = await app.query(
        `SELECT entity_id FROM canonical_entities WHERE entity_id = ANY($1::text[]) ORDER BY entity_id`,
        [[globalId, tenantAId, tenantBId]],
      );
      expect(noContext.rows.map((row) => row.entity_id)).toEqual([globalId]);

      const tenantA = await withTenant(app, 'tenant-a', (client) => client.query(
        `SELECT entity_id FROM canonical_entities WHERE entity_id = ANY($1::text[]) ORDER BY entity_id`,
        [[globalId, tenantAId, tenantBId]],
      ));
      expect(new Set(tenantA.rows.map((row) => row.entity_id))).toEqual(new Set([globalId, tenantAId]));

      const tenantB = await withTenant(app, 'tenant-b', (client) => client.query(
        `SELECT entity_id FROM canonical_entities WHERE entity_id = ANY($1::text[]) ORDER BY entity_id`,
        [[globalId, tenantAId, tenantBId]],
      ));
      expect(new Set(tenantB.rows.map((row) => row.entity_id))).toEqual(new Set([globalId, tenantBId]));

      await expect(withTenant(app, 'tenant-a', (client) => client.query(
        `INSERT INTO canonical_entities(
           entity_id,tenant_id,entity_type,canonical_name,aliases,confidence
         ) VALUES($1,NULL,'COMPANY','Forbidden Global',ARRAY['FORBIDDEN GLOBAL'],1)`,
        [`company:forbidden-global:${suffix}`],
      ))).rejects.toThrow();

      const tenantOwnedId = `company:tenant-owned:${suffix}`;
      await withTenant(app, 'tenant-a', (client) => client.query(
        `INSERT INTO canonical_entities(
           entity_id,tenant_id,entity_type,canonical_name,aliases,confidence
         ) VALUES($1,'tenant-a','COMPANY','Tenant Owned',ARRAY['TENANT OWNED'],1)`,
        [tenantOwnedId],
      ));
      const tenantOwnedAlias = await withTenant(app, 'tenant-a', (client) => client.query(
        `SELECT alias FROM canonical_entity_aliases
         WHERE entity_id=$1 AND alias='TENANT OWNED'`,
        [tenantOwnedId],
      ));
      expect(tenantOwnedAlias.rowCount).toBe(1);
      await withTenant(app, 'tenant-a', (client) => client.query(
        'DELETE FROM canonical_entities WHERE entity_id=$1',
        [tenantOwnedId],
      ));
    } finally {
      await admin.query(
        `DELETE FROM canonical_entities WHERE entity_id = ANY($1::text[])`,
        [[globalId, tenantAId, tenantBId]],
      );
    }
  });
});
