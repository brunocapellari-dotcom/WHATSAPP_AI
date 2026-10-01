import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { LocalAgroLogOutboxPublisher } from '../../src/infra/agrolog-outbox.js';

const databaseUrl = process.env.DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;

run('zero-cost AgroLog local outbox', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const tenants: string[] = [];
  const dirs: string[] = [];

  afterAll(async () => {
    for (const tenantId of tenants) {
      await pool.query('DELETE FROM outbox_events WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM tenants WHERE tenant_id=$1', [tenantId]);
    }
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
    await pool.end();
  });

  it('fsyncs an idempotent NDJSON envelope before marking the outbox row published', async () => {
    const tenantId = 'agrolog-local-' + randomUUID();
    const outboxId = randomUUID();
    const idempotencyKey = 'freight-event:' + randomUUID();
    const dir = await mkdtemp(join(tmpdir(), 'agrolog-export-'));
    tenants.push(tenantId);
    dirs.push(dir);

    await pool.query(
      'INSERT INTO tenants(tenant_id,name) VALUES($1,$2)',
      [tenantId, 'AgroLog local'],
    );
    await pool.query(
      `INSERT INTO outbox_events(
        outbox_id,tenant_id,topic,aggregate_id,idempotency_key,payload
      ) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
      [
        outboxId,
        tenantId,
        'agrolog.freight_event.v1',
        'freight-1',
        idempotencyKey,
        JSON.stringify({ freightValue: 180, unit: 'BRL/t' }),
      ],
    );

    const publisher = new LocalAgroLogOutboxPublisher(pool, {
      exportDir: dir,
      batchSize: 10,
    });
    const result = await publisher.publishBatch();

    expect(result).toEqual({ published: 1, failed: 0 });

    const files = await import('node:fs/promises').then((fs) => fs.readdir(dir));
    expect(files).toHaveLength(1);
    const lines = (await readFile(join(dir, files[0]!), 'utf8'))
      .trim()
      .split('\n');
    expect(lines).toHaveLength(1);
    const envelope = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      topic: 'agrolog.freight_event.v1',
      tenantId,
      aggregateId: 'freight-1',
      idempotencyKey,
      payload: { freightValue: 180, unit: 'BRL/t' },
    });

    const published = await pool.query(
      'SELECT published_at,last_error FROM outbox_events WHERE outbox_id=$1',
      [outboxId],
    );
    expect(published.rows[0].published_at).toBeTruthy();
    expect(published.rows[0].last_error).toBeNull();

    const second = await publisher.publishBatch();
    expect(second).toEqual({ published: 0, failed: 0 });
    const after = (await readFile(join(dir, files[0]!), 'utf8')).trim().split('\n');
    expect(after).toHaveLength(1);
  });
});
