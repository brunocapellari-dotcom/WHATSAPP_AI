import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { OperatorOutboundService } from '../../src/business/operator-outbound-service.js';
import { MemoryAuditSink } from '../../src/infra/audit.js';
import { PostgresConversationStore } from '../../src/infra/conversations.js';
import { ProviderSendError } from '../../src/providers/errors.js';
import { MockWhatsAppProvider } from '../../src/providers/mock-provider.js';
import { encryptJson } from '../../src/security/crypto.js';

const databaseUrl = process.env.DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
const encryptionSecret = 'operator-outbound-secret-123456789012345';

class FailFirstProvider extends MockWhatsAppProvider {
  attempts = 0;

  override async sendText(input: { tenantId: string; to: string; text: string }) {
    this.attempts++;
    if (this.attempts === 1) {
      throw new ProviderSendError('definite_pre_delivery_failure', false);
    }
    return super.sendText(input);
  }
}

class UncertainProvider extends MockWhatsAppProvider {
  attempts = 0;

  override async sendText() {
    this.attempts++;
    throw new ProviderSendError('transport_timeout', true);
  }
}

run('operator outbound delivery', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const tenants: string[] = [];

  afterAll(async () => {
    for (const tenantId of tenants) {
      await pool.query('DELETE FROM operator_outbound_messages WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM audit_logs WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM conversations WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM tenants WHERE tenant_id=$1', [tenantId]);
    }
    await pool.end();
  });

  async function seed(providerId: string) {
    const tenantId = 'operator-send-' + randomUUID();
    const conversationId = randomUUID();
    tenants.push(tenantId);

    await pool.query(
      'INSERT INTO tenants(tenant_id,name) VALUES($1,$2)',
      [tenantId, 'Operator outbound'],
    );
    await pool.query(
      `INSERT INTO conversations(
        conversation_id,tenant_id,provider,provider_chat_id,state,assigned_to,
        routing_address_encrypted,last_message_at
      ) VALUES($1,$2,$3,$4,'HUMAN','operator-a',$5,now())`,
      [
        conversationId,
        tenantId,
        providerId,
        'hmac:' + randomUUID(),
        encryptJson({ routingAddress: '5511999999999' }, encryptionSecret),
      ],
    );
    return { tenantId, conversationId };
  }

  function service(provider: MockWhatsAppProvider) {
    return new OperatorOutboundService(
      pool,
      new Map([[provider.id, provider]]),
      new PostgresConversationStore(pool, encryptionSecret),
      encryptionSecret,
      new MemoryAuditSink(),
    );
  }

  it('sends once and returns the same SENT record for an idempotent replay', async () => {
    const provider = new MockWhatsAppProvider();
    const seeded = await seed(provider.id);
    const outbound = service(provider);
    const requestId = randomUUID();

    const first = await outbound.send({
      ...seeded,
      operatorReference: 'operator-a',
      requestId,
      text: 'Olá, agora estou atendendo você.',
    });
    expect(first.state).toBe('SENT');
    expect(provider.sent).toHaveLength(1);

    const replay = await outbound.send({
      ...seeded,
      operatorReference: 'operator-a',
      requestId,
      text: 'Olá, agora estou atendendo você.',
    });
    expect(replay).toEqual(first);
    expect(provider.sent).toHaveLength(1);

    await expect(outbound.send({
      ...seeded,
      operatorReference: 'operator-a',
      requestId,
      text: 'Conteúdo diferente com o mesmo request id.',
    })).rejects.toThrow('operator_request_id_conflict');
    expect(provider.sent).toHaveLength(1);
  });

  it('allows safe retry only after a definite pre-delivery failure', async () => {
    const provider = new FailFirstProvider();
    const seeded = await seed(provider.id);
    const outbound = service(provider);
    const requestId = randomUUID();

    await expect(outbound.send({
      ...seeded,
      operatorReference: 'operator-a',
      requestId,
      text: 'Resposta com retry seguro.',
    })).rejects.toThrow('definite_pre_delivery_failure');

    const failed = await outbound.status(seeded.tenantId, requestId);
    expect(failed).toMatchObject({
      state: 'FAILED',
      attempts: 1,
      lastError: 'definite_pre_delivery_failure',
    });

    const retry = await outbound.send({
      ...seeded,
      operatorReference: 'operator-a',
      requestId,
      text: 'Resposta com retry seguro.',
    });
    expect(retry.state).toBe('SENT');
    expect(retry.attempts).toBe(2);
    expect(provider.attempts).toBe(2);
    expect(provider.sent).toHaveLength(1);
  });

  it('never resends an ambiguous provider delivery', async () => {
    const provider = new UncertainProvider();
    const seeded = await seed(provider.id);
    const outbound = service(provider);
    const requestId = randomUUID();

    const first = await outbound.send({
      ...seeded,
      operatorReference: 'operator-a',
      requestId,
      text: 'Resposta com entrega ambígua.',
    });
    expect(first).toMatchObject({
      state: 'DELIVERY_UNCERTAIN',
      attempts: 1,
      lastError: 'transport_timeout',
    });
    expect(provider.attempts).toBe(1);

    const replay = await outbound.send({
      ...seeded,
      operatorReference: 'operator-a',
      requestId,
      text: 'Resposta com entrega ambígua.',
    });
    expect(replay.state).toBe('DELIVERY_UNCERTAIN');
    expect(provider.attempts).toBe(1);
  });

  it('rejects an operator who does not own the conversation', async () => {
    const provider = new MockWhatsAppProvider();
    const seeded = await seed(provider.id);
    const outbound = service(provider);

    await expect(outbound.send({
      ...seeded,
      operatorReference: 'operator-b',
      requestId: randomUUID(),
      text: 'Não deveria enviar.',
    })).rejects.toThrow('conversation_not_owned_by_operator');
    expect(provider.sent).toHaveLength(0);
  });
});
