import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { OperatorService } from '../../src/business/operator-service.js';
import { PostgresAuditSink } from '../../src/infra/audit.js';

const databaseUrl = process.env.DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;

run('human operator workflow', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const tenantId = 'operator-' + randomUUID();
  const conversationId = randomUUID();

  afterAll(async () => {
    await pool.query('DELETE FROM audit_logs WHERE tenant_id=$1', [tenantId]);
    await pool.query('DELETE FROM raw_messages WHERE tenant_id=$1', [tenantId]);
    await pool.query('DELETE FROM conversations WHERE tenant_id=$1', [tenantId]);
    await pool.query('DELETE FROM tenants WHERE tenant_id=$1', [tenantId]);
    await pool.end();
  });

  it('lists, inspects, claims and transitions a handoff without leaking routing data', async () => {
    const chatId = 'hmac:chat-' + randomUUID();
    await pool.query('INSERT INTO tenants(tenant_id,name) VALUES($1,$2)', [tenantId, 'Operator']);
    await pool.query(
      `INSERT INTO conversations(
        conversation_id,tenant_id,provider,provider_chat_id,state,metadata,last_message_at
      ) VALUES($1,$2,'wppconnect',$3,'WAITING_HUMAN',$4::jsonb,now())`,
      [conversationId, tenantId, chatId, JSON.stringify({ handoffReason: 'tool_failure' })],
    );
    await pool.query(
      `INSERT INTO raw_messages(
        event_id,tenant_id,provider,collector_id,account_id,message_id,chat_id,
        occurred_at,received_at,sender_reference,message_type,text_content,
        content_hash,schema_version
      ) VALUES($1,$2,'wppconnect','collector','default',$3,$4,now(),now(),
        'hmac:sender','text','Preciso de atendimento humano',$5,1)`,
      [randomUUID(), tenantId, 'message-' + randomUUID(), chatId, 'a'.repeat(64)],
    );

    const service = new OperatorService(pool, new PostgresAuditSink(pool));

    const waiting = await service.list({ tenantId, state: 'WAITING_HUMAN' });
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({
      conversationId,
      state: 'WAITING_HUMAN',
      assignedTo: null,
    });
    expect(JSON.stringify(waiting[0])).not.toContain(chatId);

    const detail = await service.detail({ tenantId, conversationId });
    expect(detail?.messages).toHaveLength(1);
    expect(detail?.messages[0]?.text).toBe('Preciso de atendimento humano');
    expect(JSON.stringify(detail)).not.toContain(chatId);

    const claimed = await service.claim({
      tenantId,
      conversationId,
      operatorReference: 'operator-a',
    });
    expect(claimed).toMatchObject({
      state: 'HUMAN',
      assignedTo: 'operator-a',
    });

    await expect(service.claim({
      tenantId,
      conversationId,
      operatorReference: 'operator-b',
    })).rejects.toThrow('conversation_claim_conflict');

    const released = await service.transition({
      tenantId,
      conversationId,
      operatorReference: 'operator-a',
      action: 'release',
    });
    expect(released).toMatchObject({
      state: 'WAITING_HUMAN',
      assignedTo: null,
    });

    const reclaimed = await service.claim({
      tenantId,
      conversationId,
      operatorReference: 'operator-a',
    });
    expect(reclaimed.state).toBe('HUMAN');

    const resumed = await service.transition({
      tenantId,
      conversationId,
      operatorReference: 'operator-a',
      action: 'resume_ai',
    });
    expect(resumed).toMatchObject({
      state: 'OPEN',
      assignedTo: null,
    });

    await pool.query(
      `UPDATE conversations
       SET state='WAITING_HUMAN',assigned_to=NULL
       WHERE tenant_id=$1 AND conversation_id=$2`,
      [tenantId, conversationId],
    );
    await service.claim({
      tenantId,
      conversationId,
      operatorReference: 'operator-a',
    });

    const closed = await service.transition({
      tenantId,
      conversationId,
      operatorReference: 'operator-a',
      action: 'close',
    });
    expect(closed).toMatchObject({
      state: 'CLOSED',
      assignedTo: 'operator-a',
    });

    const audit = await pool.query(
      `SELECT action,actor,outcome
       FROM audit_logs
       WHERE tenant_id=$1
       ORDER BY audit_id`,
      [tenantId],
    );
    expect(audit.rows.some((row) =>
      row.action === 'conversation_claim'
      && row.actor === 'operator:operator-a'
      && row.outcome === 'ALLOW'
    )).toBe(true);
    expect(audit.rows.some((row) => row.action === 'conversation_close')).toBe(true);
  });
});
