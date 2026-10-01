import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { FollowupDeliveryService } from '../../src/business/followup-delivery-service.js';
import { PostgresConversationStore } from '../../src/infra/conversations.js';
import { ProviderSendError } from '../../src/providers/errors.js';
import { MockWhatsAppProvider } from '../../src/providers/mock-provider.js';
import { encryptJson } from '../../src/security/crypto.js';

const databaseUrl = process.env.DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
const encryptionSecret = 'followup-test-encryption-secret-1234567890';

class DefiniteFailureProvider extends MockWhatsAppProvider {
  override async sendText() {
    throw new ProviderSendError('definite_pre_delivery_failure', false);
  }
}

class UncertainFailureProvider extends MockWhatsAppProvider {
  override async sendText() {
    throw new ProviderSendError('transport_timeout', true);
  }
}

run('durable follow-up delivery', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const tenantIds: string[] = [];

  afterAll(async () => {
    for (const tenantId of tenantIds) {
      await pool.query('DELETE FROM followups WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM customers WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM conversations WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM tenants WHERE tenant_id=$1', [tenantId]);
    }
    await pool.end();
  });

  async function seed(providerId: string) {
    const tenantId = 'followup-' + randomUUID();
    const conversationId = randomUUID();
    const customerId = randomUUID();
    const followupId = randomUUID();
    tenantIds.push(tenantId);

    await pool.query(
      'INSERT INTO tenants(tenant_id,name) VALUES($1,$2)',
      [tenantId, 'Followup test'],
    );
    await pool.query(
      `INSERT INTO conversations(
        conversation_id,tenant_id,provider,provider_chat_id,state,
        routing_address_encrypted,last_message_at
      ) VALUES($1,$2,$3,$4,'OPEN',$5,now())`,
      [
        conversationId,
        tenantId,
        providerId,
        'hmac:' + randomUUID(),
        encryptJson({ routingAddress: '5511999999999' }, encryptionSecret),
      ],
    );
    await pool.query(
      `INSERT INTO customers(
        customer_id,tenant_id,name,phone_reference
      ) VALUES($1,$2,'Cliente','hmac:phone')`,
      [customerId, tenantId],
    );
    await pool.query(
      `INSERT INTO followups(
        followup_id,tenant_id,customer_id,conversation_id,due_at,next_attempt_at,
        reason,message_text,status
      ) VALUES($1,$2,$3,$4,now()-interval '1 minute',now()-interval '1 minute',
        'Retorno comercial','Olá! Estou retornando sobre nossa conversa.','PENDING')`,
      [followupId, tenantId, customerId, conversationId],
    );

    return { tenantId, conversationId, followupId };
  }

  it('marks a confirmed provider send as DONE exactly once', async () => {
    const provider = new MockWhatsAppProvider();
    const seeded = await seed(provider.id);
    const service = new FollowupDeliveryService(
      pool,
      new Map([[provider.id, provider]]),
      new PostgresConversationStore(pool, encryptionSecret),
    );

    expect(await service.deliverBatch()).toEqual({
      sent: 1,
      retrying: 0,
      failed: 0,
      uncertain: 0,
    });
    expect(provider.sent).toEqual([{
      to: '5511999999999',
      text: 'Olá! Estou retornando sobre nossa conversa.',
    }]);

    const row = await pool.query(
      'SELECT status,sent_message_id,attempts FROM followups WHERE followup_id=$1',
      [seeded.followupId],
    );
    expect(row.rows[0].status).toBe('DONE');
    expect(row.rows[0].sent_message_id).toMatch(/^mock-/);
    expect(row.rows[0].attempts).toBe(0);

    expect(await service.deliverBatch()).toEqual({
      sent: 0,
      retrying: 0,
      failed: 0,
      uncertain: 0,
    });
    expect(provider.sent).toHaveLength(1);
  });

  it('returns a definite pre-delivery failure to PENDING with backoff', async () => {
    const provider = new DefiniteFailureProvider();
    const seeded = await seed(provider.id);
    const service = new FollowupDeliveryService(
      pool,
      new Map([[provider.id, provider]]),
      new PostgresConversationStore(pool, encryptionSecret),
    );

    expect(await service.deliverBatch()).toEqual({
      sent: 0,
      retrying: 1,
      failed: 0,
      uncertain: 0,
    });

    const row = await pool.query(
      'SELECT status,attempts,last_error,next_attempt_at FROM followups WHERE followup_id=$1',
      [seeded.followupId],
    );
    expect(row.rows[0].status).toBe('PENDING');
    expect(row.rows[0].attempts).toBe(1);
    expect(row.rows[0].last_error).toBe('definite_pre_delivery_failure');
    expect(new Date(row.rows[0].next_attempt_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('never retries an uncertain delivery and escalates the conversation to a human', async () => {
    const provider = new UncertainFailureProvider();
    const seeded = await seed(provider.id);
    const service = new FollowupDeliveryService(
      pool,
      new Map([[provider.id, provider]]),
      new PostgresConversationStore(pool, encryptionSecret),
    );

    expect(await service.deliverBatch()).toEqual({
      sent: 0,
      retrying: 0,
      failed: 0,
      uncertain: 1,
    });

    const followup = await pool.query(
      'SELECT status,attempts,last_error FROM followups WHERE followup_id=$1',
      [seeded.followupId],
    );
    expect(followup.rows[0]).toMatchObject({
      status: 'DELIVERY_UNCERTAIN',
      attempts: 1,
      last_error: 'transport_timeout',
    });

    const conversation = await pool.query(
      'SELECT state,metadata FROM conversations WHERE conversation_id=$1',
      [seeded.conversationId],
    );
    expect(conversation.rows[0].state).toBe('WAITING_HUMAN');
    expect(conversation.rows[0].metadata).toMatchObject({
      handoffReason: 'followup_delivery_uncertain',
      followupId: seeded.followupId,
    });

    expect(await service.deliverBatch()).toEqual({
      sent: 0,
      retrying: 0,
      failed: 0,
      uncertain: 0,
    });
  });
});
