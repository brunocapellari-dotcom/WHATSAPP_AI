import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { ApprovalService } from '../../src/business/approval-service.js';
import { buildPostgresBusinessTools } from '../../src/business/postgres-tools.js';
import { PostgresAuditSink } from '../../src/infra/audit.js';

const databaseUrl = process.env.DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
const encryptionSecret = 'approval-test-encryption-secret-123456789';

run('financial approval workflow', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const tenantId = 'approval-' + randomUUID();
  const conversationId = randomUUID();
  const customerId = randomUUID();
  const orderId = randomUUID();

  afterAll(async () => {
    await pool.query('DELETE FROM approval_requests WHERE tenant_id=$1', [tenantId]);
    await pool.query('DELETE FROM audit_logs WHERE tenant_id=$1', [tenantId]);
    await pool.query('DELETE FROM payments WHERE tenant_id=$1', [tenantId]);
    await pool.query('DELETE FROM orders WHERE tenant_id=$1', [tenantId]);
    await pool.query('DELETE FROM customers WHERE tenant_id=$1', [tenantId]);
    await pool.query('DELETE FROM conversations WHERE tenant_id=$1', [tenantId]);
    await pool.query('DELETE FROM tenants WHERE tenant_id=$1', [tenantId]);
    await pool.end();
  });

  it('persists, inspects and executes an approved payment exactly once', async () => {
    await pool.query('INSERT INTO tenants(tenant_id,name) VALUES($1,$2)', [tenantId, 'Approval']);
    await pool.query(
      `INSERT INTO conversations(
        conversation_id,tenant_id,provider,provider_chat_id,state
      ) VALUES($1,$2,'mock',$3,'WAITING_HUMAN')`,
      [conversationId, tenantId, 'hmac:' + randomUUID()],
    );
    await pool.query(
      `INSERT INTO customers(customer_id,tenant_id,name,phone_reference)
       VALUES($1,$2,'Cliente','hmac:phone')`,
      [customerId, tenantId],
    );
    await pool.query(
      `INSERT INTO orders(order_id,tenant_id,customer_id,payload)
       VALUES($1,$2,$3,'{}'::jsonb)`,
      [orderId, tenantId, customerId],
    );

    const audit = new PostgresAuditSink(pool);
    const tools = buildPostgresBusinessTools(pool, 'p'.repeat(32), audit);
    const approvals = new ApprovalService(pool, encryptionSecret, tools, audit);

    const requested = await approvals.request({
      tenantId,
      conversationId,
      sourceMessageId: 'payment-source-1',
      toolName: 'registrar_pagamento',
      risk: 'FINANCIAL',
      toolInput: {
        orderId,
        amount: 250,
        reference: 'PIX-confirmado-001',
      },
      requestedBy: 'agent:SALES',
    });

    expect(requested.status).toBe('PENDING');
    expect((await pool.query(
      'SELECT count(*)::int AS count FROM payments WHERE tenant_id=$1',
      [tenantId],
    )).rows[0].count).toBe(0);

    const replay = await approvals.request({
      tenantId,
      conversationId,
      sourceMessageId: 'payment-source-1',
      toolName: 'registrar_pagamento',
      risk: 'FINANCIAL',
      toolInput: {
        reference: 'PIX-confirmado-001',
        amount: 250,
        orderId,
      },
      requestedBy: 'agent:SALES',
    });
    expect(replay.approvalId).toBe(requested.approvalId);

    const detail = await approvals.detail(tenantId, requested.approvalId);
    expect(detail).toMatchObject({
      approvalId: requested.approvalId,
      status: 'PENDING',
      toolName: 'registrar_pagamento',
      input: {
        orderId,
        amount: 250,
        reference: 'PIX-confirmado-001',
      },
    });

    const executed = await approvals.approve({
      tenantId,
      approvalId: requested.approvalId,
      operatorReference: 'financeiro-1',
    });
    expect(executed.status).toBe('EXECUTED');

    const payments = await pool.query(
      `SELECT order_id,amount,reference
       FROM payments
       WHERE tenant_id=$1`,
      [tenantId],
    );
    expect(payments.rows).toHaveLength(1);
    expect(payments.rows[0]).toMatchObject({
      order_id: orderId,
      reference: 'PIX-confirmado-001',
    });
    expect(Number(payments.rows[0].amount)).toBe(250);

    await expect(approvals.approve({
      tenantId,
      approvalId: requested.approvalId,
      operatorReference: 'financeiro-1',
    })).rejects.toThrow('approval_not_pending:EXECUTED');

    expect((await pool.query(
      'SELECT count(*)::int AS count FROM payments WHERE tenant_id=$1',
      [tenantId],
    )).rows[0].count).toBe(1);
  });

  it('rejects an approval without executing the tool', async () => {
    const audit = new PostgresAuditSink(pool);
    const tools = buildPostgresBusinessTools(pool, 'p'.repeat(32), audit);
    const approvals = new ApprovalService(pool, encryptionSecret, tools, audit);

    const requested = await approvals.request({
      tenantId,
      conversationId,
      sourceMessageId: 'payment-source-2',
      toolName: 'registrar_pagamento',
      risk: 'FINANCIAL',
      toolInput: {
        orderId,
        amount: 100,
        reference: 'NAO-APROVAR',
      },
      requestedBy: 'agent:SALES',
    });

    const rejected = await approvals.reject({
      tenantId,
      approvalId: requested.approvalId,
      operatorReference: 'financeiro-1',
      reason: 'Comprovante não validado',
    });
    expect(rejected.status).toBe('REJECTED');

    const payments = await pool.query(
      `SELECT count(*)::int AS count
       FROM payments
       WHERE tenant_id=$1 AND reference='NAO-APROVAR'`,
      [tenantId],
    );
    expect(payments.rows[0].count).toBe(0);
  });
});
