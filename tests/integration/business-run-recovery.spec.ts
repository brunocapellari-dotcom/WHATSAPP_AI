import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { RawMessage } from '../../src/domain/schemas.js';
import { PostgresBusinessRunStore } from '../../src/infra/business-runs.js';

const databaseUrl = process.env.DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;

run('business run crash recovery', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const cleanupTenants: string[] = [];

  afterAll(async () => {
    for (const tenantId of cleanupTenants) {
      await pool.query('DELETE FROM business_message_runs WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM conversations WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM tenants WHERE tenant_id=$1', [tenantId]);
    }
    await pool.end();
  });

  it('converts stale processing to FAILED and stale sending to DELIVERY_UNCERTAIN', async () => {
    const tenantId = 'business-recovery-' + randomUUID();
    const conversationId = randomUUID();
    cleanupTenants.push(tenantId);

    await pool.query('INSERT INTO tenants(tenant_id,name) VALUES($1,$2)', [tenantId, 'Business Recovery']);
    await pool.query(
      `INSERT INTO conversations(conversation_id,tenant_id,provider,provider_chat_id)
       VALUES($1,$2,'mock',$3)`,
      [conversationId, tenantId, 'chat-' + randomUUID()],
    );

    const message: RawMessage = {
      eventId: randomUUID(),
      tenantId,
      provider: 'mock',
      collectorId: 'collector-test',
      accountId: 'account-test',
      messageId: 'message-' + randomUUID(),
      chatId: 'chat-ref-' + randomUUID(),
      groupId: null,
      occurredAt: new Date(),
      receivedAt: new Date(),
      senderReference: 'hmac:test',
      routingAddress: '5511999999999',
      messageType: 'text',
      text: 'Quero um orçamento.',
      attachmentReference: null,
      replyContext: null,
      contentHash: 'a'.repeat(64),
      schemaVersion: 1,
    };

    const store = new PostgresBusinessRunStore(pool, 'k'.repeat(32));
    const first = await store.claim(message, conversationId);
    expect(first.state).toBe('NEW');

    await pool.query(
      `UPDATE business_message_runs
       SET updated_at=now()-interval '3 minutes'
       WHERE run_id=$1`,
      [first.runId],
    );

    const recoveredProcessing = await store.claim(message, conversationId);
    expect(recoveredProcessing.state).toBe('FAILED');

    await store.completeProcessing(tenantId, first.runId, {
      reply: 'Encaminhado para revisão humana.',
      handoff: true,
      handoffReason: 'previous_processing_uncertain',
    });
    await store.beginSend(tenantId, first.runId);

    await pool.query(
      `UPDATE business_message_runs
       SET send_started_at=now()-interval '2 minutes'
       WHERE run_id=$1`,
      [first.runId],
    );

    const recoveredSending = await store.claim(message, conversationId);
    expect(recoveredSending.state).toBe('DELIVERY_UNCERTAIN');

    const row = await pool.query(
      `SELECT state,send_attempts,last_error
       FROM business_message_runs
       WHERE run_id=$1`,
      [first.runId],
    );
    expect(row.rows[0].state).toBe('DELIVERY_UNCERTAIN');
    expect(row.rows[0].send_attempts).toBe(1);
    expect(row.rows[0].last_error).toBe('stale_sending_uncertain');
  });
});
