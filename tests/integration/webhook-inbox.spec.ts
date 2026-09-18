import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { buildHttpApp } from '../../src/http/app.js';
import { loadConfig } from '../../src/config.js';
import { MemoryCollectorResolver } from '../../src/infra/collectors.js';
import { WebhookInbox } from '../../src/infra/webhook-inbox.js';
import { Metrics } from '../../src/observability/metrics.js';
import { MetaCloudProvider } from '../../src/providers/meta-cloud-provider.js';

const databaseUrl = process.env.DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;

run('durable webhook inbox', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const encryptionKey = 'i'.repeat(32);
  const inbox = new WebhookInbox(pool, encryptionKey);
  const cleanupTenants: string[] = [];

  afterAll(async () => {
    for (const tenantId of cleanupTenants) {
      await pool.query('DELETE FROM webhook_inbox WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM collectors WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM tenants WHERE tenant_id=$1', [tenantId]);
    }
    await pool.end();
  });

  it('persists one encrypted envelope for duplicate deliveries', async () => {
    const tenantId = 'inbox-' + randomUUID();
    const collectorId = 'collector-' + randomUUID();
    cleanupTenants.push(tenantId);
    await pool.query('INSERT INTO tenants(tenant_id,name) VALUES($1,$2)', [tenantId, 'Inbox Test']);
    await pool.query("INSERT INTO collectors(collector_id,tenant_id,provider,account,source_type,purpose,status,version) VALUES($1,$2,'meta-cloud','acct','webhook','FREIGHT_INTELLIGENCE','HEALTHY','test')", [collectorId, tenantId]);
    const raw = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ value: { messages: [{ id: 'wamid.1', type: 'text', from: 'sender-1', text: { body: 'SOJA' } }] } }] }] }));
    const first = await inbox.accept({ tenantId, provider: 'meta-cloud', collectorId, rawBody: raw });
    const replay = await inbox.accept({ tenantId, provider: 'meta-cloud', collectorId, rawBody: raw });
    expect(first.inserted).toBe(true);
    expect(replay.inserted).toBe(false);
    expect(replay.ingressId).toBe(first.ingressId);
    const stored = await pool.query('SELECT encrypted_payload FROM webhook_inbox WHERE ingress_id=$1', [first.ingressId]);
    const encrypted = Buffer.from(stored.rows[0].encrypted_payload);
    expect(encrypted.includes(Buffer.from('sender-1'))).toBe(false);
    const claimed = await inbox.claimBatch(100);
    const item = claimed.find((candidate) => candidate.ingressId === first.ingressId);
    expect(item?.payload).toEqual(JSON.parse(raw.toString('utf8')));
    expect(item).toBeTruthy();
    expect(await inbox.fail(first.ingressId, item!.lockToken, item!.attempts, 'temporary')).toBe(true);
    const failedState = await pool.query('SELECT state,last_error FROM webhook_inbox WHERE ingress_id=$1', [first.ingressId]);
    expect(failedState.rows[0].state).toBe('RECEIVED');
    expect(failedState.rows[0].last_error).toBe('temporary');
    await pool.query('UPDATE webhook_inbox SET next_attempt_at=now() WHERE ingress_id=$1', [first.ingressId]);
    const reclaimed = await inbox.claimBatch(100);
    const retry = reclaimed.find((candidate) => candidate.ingressId === first.ingressId);
    expect(retry).toBeTruthy();
    expect(retry).toBeTruthy();
    const staleLock = retry!.lockToken;
    await pool.query("UPDATE webhook_inbox SET locked_at=now()-interval '6 minutes' WHERE ingress_id=$1", [first.ingressId]);
    const reclaimedAgain = await inbox.claimBatch(100);
    const current = reclaimedAgain.find((candidate) => candidate.ingressId === first.ingressId);
    expect(current).toBeTruthy();
    expect(current!.lockToken).not.toBe(staleLock);
    expect(await inbox.complete(first.ingressId, staleLock)).toBe(false);
    expect(await inbox.complete(first.ingressId, current!.lockToken)).toBe(true);
    const done = await pool.query('SELECT state,processed_at FROM webhook_inbox WHERE ingress_id=$1', [first.ingressId]);
    expect(done.rows[0].state).toBe('DONE');
    expect(done.rows[0].processed_at).toBeTruthy();
  });

  it('ACKs a valid Meta webhook after durable persistence', async () => {
    const tenantId = 'http-inbox-' + randomUUID();
    const collectorId = 'collector-' + randomUUID();
    cleanupTenants.push(tenantId);
    await pool.query('INSERT INTO tenants(tenant_id,name) VALUES($1,$2)', [tenantId, 'HTTP Inbox Test']);
    await pool.query("INSERT INTO collectors(collector_id,tenant_id,provider,account,source_type,purpose,status,version) VALUES($1,$2,'meta-cloud','acct','webhook','FREIGHT_INTELLIGENCE','HEALTHY','test')", [collectorId, tenantId]);
    const appSecret = 'meta-app-secret';
    const config = loadConfig({
      APP_ENCRYPTION_KEY: 'a'.repeat(32), PII_HMAC_KEY: 'b'.repeat(32),
      INTERNAL_API_KEY: 'internal-api-key-123456', META_VERIFY_TOKEN: 'verify-token', META_APP_SECRET: appSecret,
    });
    const provider = new MetaCloudProvider({ piiHmacKey: 'b'.repeat(32) });
    const app = await buildHttpApp({
      config,
      collectors: new MemoryCollectorResolver([{ collectorId, tenantId, provider: 'meta-cloud', account: 'acct', purpose: 'FREIGHT_INTELLIGENCE', status: 'HEALTHY' }]),
      providers: new Map([[provider.id, provider]]), webhookInbox: inbox, metrics: new Metrics(), pool,
    });
    try {
      const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ value: { messages: [{ id: 'wamid.http', from: 'sender-2', type: 'text', text: { body: 'SOJA Frete R$ 180' } }] } }] }] });
      const signature = 'sha256=' + createHmac('sha256', appSecret).update(payload).digest('hex');
      const response = await app.inject({ method: 'POST', url: '/webhooks/meta/' + collectorId, headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature }, payload });
      expect(response.statusCode).toBe(200);
      expect(response.json().accepted).toBe(true);
      const count = await pool.query('SELECT count(*)::int AS n FROM webhook_inbox WHERE tenant_id=$1 AND collector_id=$2', [tenantId, collectorId]);
      expect(count.rows[0].n).toBe(1);
    } finally {
      await app.close();
    }
  });
});
