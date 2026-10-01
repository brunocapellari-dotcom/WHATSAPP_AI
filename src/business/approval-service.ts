import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { AuditSink } from '../domain/ports.js';
import { decryptJson, encryptJson, sha256 } from '../security/crypto.js';
import { tenantQuery, withTenant } from '../infra/tenant-db.js';
import type { ToolRisk } from '../security/policy.js';
import type { ToolRegistry } from './tool-registry.js';

type ApprovalStatus =
  | 'PENDING'
  | 'EXECUTING'
  | 'EXECUTED'
  | 'REJECTED'
  | 'FAILED'
  | 'EXPIRED';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export type ApprovalRequestResult = {
  approvalId: string;
  status: ApprovalStatus;
};

export interface ApprovalRequester {
  request(input: {
    tenantId: string;
    conversationId: string;
    sourceMessageId: string;
    toolName: string;
    risk: 'FINANCIAL' | 'IRREVERSIBLE';
    toolInput: unknown;
    requestedBy: string;
  }): Promise<ApprovalRequestResult>;
}

export class ApprovalService implements ApprovalRequester {
  constructor(
    private readonly pool: Pool,
    private readonly encryptionSecret: string,
    private readonly tools: ToolRegistry,
    private readonly audit: AuditSink,
  ) {}

  async request(input: {
    tenantId: string;
    conversationId: string;
    sourceMessageId: string;
    toolName: string;
    risk: 'FINANCIAL' | 'IRREVERSIBLE';
    toolInput: unknown;
    requestedBy: string;
  }): Promise<ApprovalRequestResult> {
    const prepared = this.tools.prepare(input.toolName, input.toolInput);
    if (prepared.risk !== input.risk) {
      throw new Error('approval_risk_mismatch');
    }
    if (prepared.risk !== 'FINANCIAL' && prepared.risk !== 'IRREVERSIBLE') {
      throw new Error('approval_not_required');
    }

    const requestKey = sha256(JSON.stringify(canonicalize({
      conversationId: input.conversationId,
      sourceMessageId: input.sourceMessageId,
      toolName: input.toolName,
      input: prepared.input,
    })));
    const approvalId = randomUUID();
    const encrypted = encryptJson({ input: prepared.input }, this.encryptionSecret, 'approval-input');

    const result = await tenantQuery<{
      approval_id: string;
      status: ApprovalStatus;
    }>(
      this.pool,
      input.tenantId,
      `INSERT INTO approval_requests(
         approval_id,tenant_id,conversation_id,source_message_id,request_key,
         tool_name,risk,input_encrypted,requested_by
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT(tenant_id,request_key)
       DO UPDATE SET updated_at=now()
       RETURNING approval_id,status`,
      [
        approvalId,
        input.tenantId,
        input.conversationId,
        input.sourceMessageId,
        requestKey,
        input.toolName,
        input.risk,
        encrypted,
        input.requestedBy,
      ],
    );

    const row = result.rows[0];
    if (!row) throw new Error('approval_request_persistence_failed');

    await this.audit.write({
      tenantId: input.tenantId,
      actor: input.requestedBy,
      action: 'approval_requested',
      outcome: 'ALLOW',
      target: row.approval_id,
      metadata: { toolName: input.toolName, risk: input.risk },
    });

    return { approvalId: row.approval_id, status: row.status };
  }

  async list(input: {
    tenantId: string;
    status?: ApprovalStatus;
    limit?: number;
  }) {
    const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
    const values: unknown[] = [input.tenantId];
    const statusSql = input.status ? ' AND status=$2' : '';
    if (input.status) values.push(input.status);
    values.push(limit);

    const result = await tenantQuery<{
      approval_id: string;
      conversation_id: string;
      source_message_id: string;
      tool_name: string;
      risk: 'FINANCIAL' | 'IRREVERSIBLE';
      status: ApprovalStatus;
      requested_by: string;
      decided_by: string | null;
      requested_at: Date;
      decided_at: Date | null;
      last_error: string | null;
    }>(
      this.pool,
      input.tenantId,
      `SELECT
         approval_id,conversation_id,source_message_id,tool_name,risk,status,
         requested_by,decided_by,requested_at,decided_at,last_error
       FROM approval_requests
       WHERE tenant_id=$1${statusSql}
       ORDER BY requested_at DESC
       LIMIT $${values.length}`,
      values,
    );

    return result.rows.map((row) => ({
      approvalId: row.approval_id,
      conversationId: row.conversation_id,
      sourceMessageId: row.source_message_id,
      toolName: row.tool_name,
      risk: row.risk,
      status: row.status,
      requestedBy: row.requested_by,
      decidedBy: row.decided_by,
      requestedAt: row.requested_at,
      decidedAt: row.decided_at,
      lastError: row.last_error,
    }));
  }

  async detail(tenantId: string, approvalId: string) {
    const result = await tenantQuery<{
      approval_id: string;
      conversation_id: string;
      source_message_id: string;
      tool_name: string;
      risk: 'FINANCIAL' | 'IRREVERSIBLE';
      input_encrypted: Buffer;
      status: ApprovalStatus;
      requested_by: string;
      decided_by: string | null;
      requested_at: Date;
      decided_at: Date | null;
      execution_result_encrypted: Buffer | null;
      last_error: string | null;
    }>(
      this.pool,
      tenantId,
      `SELECT
         approval_id,conversation_id,source_message_id,tool_name,risk,
         input_encrypted,status,requested_by,decided_by,requested_at,decided_at,
         execution_result_encrypted,last_error
       FROM approval_requests
       WHERE tenant_id=$1 AND approval_id=$2
       LIMIT 1`,
      [tenantId, approvalId],
    );

    const row = result.rows[0];
    if (!row) return null;
    const payload = decryptJson<{ input: unknown }>(
      row.input_encrypted,
      this.encryptionSecret,
      'approval-input',
    );
    const executionResult = row.execution_result_encrypted
      ? decryptJson<unknown>(row.execution_result_encrypted, this.encryptionSecret, 'approval-result')
      : null;

    return {
      approvalId: row.approval_id,
      conversationId: row.conversation_id,
      sourceMessageId: row.source_message_id,
      toolName: row.tool_name,
      risk: row.risk,
      input: payload.input,
      status: row.status,
      requestedBy: row.requested_by,
      decidedBy: row.decided_by,
      requestedAt: row.requested_at,
      decidedAt: row.decided_at,
      executionResult,
      lastError: row.last_error,
    };
  }

  async approve(input: {
    tenantId: string;
    approvalId: string;
    operatorReference: string;
  }) {
    const claimed = await withTenant(this.pool, input.tenantId, async (client) => {
      const result = await client.query<{
        approval_id: string;
        conversation_id: string;
        tool_name: string;
        risk: ToolRisk;
        input_encrypted: Buffer;
      }>(
        `UPDATE approval_requests
         SET status='EXECUTING',
             decided_by=$3,
             decided_at=now(),
             updated_at=now(),
             last_error=NULL
         WHERE tenant_id=$1
           AND approval_id=$2
           AND status='PENDING'
         RETURNING approval_id,conversation_id,tool_name,risk,input_encrypted`,
        [input.tenantId, input.approvalId, input.operatorReference],
      );
      return result.rows[0] ?? null;
    });

    if (!claimed) {
      const existing = await this.detail(input.tenantId, input.approvalId);
      if (!existing) throw new Error('approval_not_found');
      throw new Error(`approval_not_pending:${existing.status}`);
    }

    const payload = decryptJson<{ input: unknown }>(
      claimed.input_encrypted,
      this.encryptionSecret,
      'approval-input',
    );

    let output: unknown;
    try {
      output = await this.tools.call(claimed.tool_name, payload.input, {
        tenantId: input.tenantId,
        actor: `operator:${input.operatorReference}`,
        role: 'human',
        approved: true,
        conversationId: claimed.conversation_id,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'approval_execution_failed';
      await tenantQuery(
        this.pool,
        input.tenantId,
        `UPDATE approval_requests
         SET status='FAILED',last_error=$3,updated_at=now()
         WHERE tenant_id=$1 AND approval_id=$2 AND status='EXECUTING'`,
        [input.tenantId, input.approvalId, message.slice(0, 1000)],
      );
      throw error;
    }

    const resultEncrypted = encryptJson(output, this.encryptionSecret, 'approval-result');
    const completed = await tenantQuery(
      this.pool,
      input.tenantId,
      `UPDATE approval_requests
       SET status='EXECUTED',
           execution_result_encrypted=$3,
           last_error=NULL,
           updated_at=now()
       WHERE tenant_id=$1 AND approval_id=$2 AND status='EXECUTING'`,
      [input.tenantId, input.approvalId, resultEncrypted],
    );

    if (completed.rowCount !== 1) {
      // Never retry automatically: the tool may already have executed.
      throw new Error('approval_execution_result_persistence_uncertain');
    }

    await this.audit.write({
      tenantId: input.tenantId,
      actor: `operator:${input.operatorReference}`,
      action: 'approval_executed',
      outcome: 'ALLOW',
      target: input.approvalId,
      metadata: { toolName: claimed.tool_name, risk: claimed.risk },
    });

    return {
      approvalId: input.approvalId,
      status: 'EXECUTED' as const,
      output,
    };
  }

  async reject(input: {
    tenantId: string;
    approvalId: string;
    operatorReference: string;
    reason?: string;
  }) {
    const result = await tenantQuery(
      this.pool,
      input.tenantId,
      `UPDATE approval_requests
       SET status='REJECTED',
           decided_by=$3,
           decided_at=now(),
           last_error=$4,
           updated_at=now()
       WHERE tenant_id=$1 AND approval_id=$2 AND status='PENDING'`,
      [
        input.tenantId,
        input.approvalId,
        input.operatorReference,
        input.reason?.slice(0, 1000) ?? null,
      ],
    );

    if (result.rowCount !== 1) {
      const existing = await this.detail(input.tenantId, input.approvalId);
      if (!existing) throw new Error('approval_not_found');
      throw new Error(`approval_not_pending:${existing.status}`);
    }

    await this.audit.write({
      tenantId: input.tenantId,
      actor: `operator:${input.operatorReference}`,
      action: 'approval_rejected',
      outcome: 'ALLOW',
      target: input.approvalId,
      metadata: { reason: input.reason ?? null },
    });

    return { approvalId: input.approvalId, status: 'REJECTED' as const };
  }
}
