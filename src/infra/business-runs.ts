import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type {
  BusinessRunClaim,
  BusinessRunResult,
  BusinessRunStore,
} from '../domain/ports.js';
import type { RawMessage } from '../domain/schemas.js';
import { decryptJson, encryptJson } from '../security/crypto.js';
import { tenantQuery } from './tenant-db.js';

type MemoryRun = {
  runId: string;
  tenantId: string;
  state: 'PROCESSING' | 'PENDING_SEND' | 'SENT' | 'FAILED';
  result?: BusinessRunResult;
  replyMessageId?: string;
};

export class MemoryBusinessRunStore implements BusinessRunStore {
  readonly rows = new Map<string, MemoryRun>();

  async claim(message: RawMessage): Promise<BusinessRunClaim> {
    const key = `${message.tenantId}:${message.provider}:${message.messageId}`;
    const existing = this.rows.get(key);
    if (!existing) {
      const runId = randomUUID();
      this.rows.set(key, {
        runId,
        tenantId: message.tenantId,
        state: 'PROCESSING',
      });
      return { state: 'NEW', runId };
    }
    if (existing.state === 'PENDING_SEND' && existing.result) {
      return { state: 'PENDING_SEND', runId: existing.runId, result: existing.result };
    }
    if (existing.state === 'SENT' && existing.result) {
      return {
        state: 'SENT',
        runId: existing.runId,
        result: existing.result,
        ...(existing.replyMessageId ? { replyMessageId: existing.replyMessageId } : {}),
      };
    }
    return { state: existing.state, runId: existing.runId } as BusinessRunClaim;
  }

  async completeProcessing(_tenantId: string, runId: string, result: BusinessRunResult) {
    const row = [...this.rows.values()].find((candidate) => candidate.runId === runId);
    if (!row) throw new Error('business_run_not_found');
    row.result = result;
    row.state = 'PENDING_SEND';
  }

  async markSent(_tenantId: string, runId: string, replyMessageId: string) {
    const row = [...this.rows.values()].find((candidate) => candidate.runId === runId);
    if (!row) throw new Error('business_run_not_found');
    row.replyMessageId = replyMessageId;
    row.state = 'SENT';
  }

  async markFailed(_tenantId: string, runId: string) {
    const row = [...this.rows.values()].find((candidate) => candidate.runId === runId);
    if (!row) return;
    row.state = 'FAILED';
  }
}

type DbRun = {
  run_id: string;
  state: 'PROCESSING' | 'PENDING_SEND' | 'SENT' | 'FAILED';
  result_encrypted: Buffer | null;
  reply_message_id: string | null;
};

export class PostgresBusinessRunStore implements BusinessRunStore {
  constructor(
    private readonly pool: Pool,
    private readonly encryptionSecret: string,
  ) {}

  async claim(message: RawMessage, conversationId: string): Promise<BusinessRunClaim> {
    const proposedRunId = randomUUID();
    const inserted = await tenantQuery<{ run_id: string }>(
      this.pool,
      message.tenantId,
      `INSERT INTO business_message_runs(
         run_id,tenant_id,provider,source_message_id,conversation_id,state
       ) VALUES($1,$2,$3,$4,$5,'PROCESSING')
       ON CONFLICT (tenant_id,provider,source_message_id) DO NOTHING
       RETURNING run_id`,
      [
        proposedRunId,
        message.tenantId,
        message.provider,
        message.messageId,
        conversationId,
      ],
    );

    if (inserted.rowCount === 1) {
      return { state: 'NEW', runId: proposedRunId };
    }

    const existing = await tenantQuery<DbRun>(
      this.pool,
      message.tenantId,
      `SELECT run_id,state,result_encrypted,reply_message_id
       FROM business_message_runs
       WHERE tenant_id=$1 AND provider=$2 AND source_message_id=$3
       LIMIT 1`,
      [message.tenantId, message.provider, message.messageId],
    );
    const row = existing.rows[0];
    if (!row) throw new Error('business_run_claim_failed');

    if ((row.state === 'PENDING_SEND' || row.state === 'SENT') && row.result_encrypted) {
      const result = decryptJson<BusinessRunResult>(row.result_encrypted, this.encryptionSecret);
      if (row.state === 'PENDING_SEND') {
        return { state: 'PENDING_SEND', runId: row.run_id, result };
      }
      return {
        state: 'SENT',
        runId: row.run_id,
        result,
        ...(row.reply_message_id ? { replyMessageId: row.reply_message_id } : {}),
      };
    }

    return { state: row.state, runId: row.run_id };
  }

  async completeProcessing(
    tenantId: string,
    runId: string,
    result: BusinessRunResult,
  ): Promise<void> {
    const encrypted = encryptJson(result, this.encryptionSecret);
    const updated = await tenantQuery(
      this.pool,
      tenantId,
      `UPDATE business_message_runs
       SET state='PENDING_SEND',
           result_encrypted=$3,
           last_error=NULL,
           updated_at=now()
       WHERE tenant_id=$1 AND run_id=$2 AND state='PROCESSING'`,
      [tenantId, runId, encrypted],
    );
    if (updated.rowCount !== 1) throw new Error('business_run_transition_failed');
  }

  async markSent(tenantId: string, runId: string, replyMessageId: string): Promise<void> {
    const updated = await tenantQuery(
      this.pool,
      tenantId,
      `UPDATE business_message_runs
       SET state='SENT',reply_message_id=$3,last_error=NULL,updated_at=now()
       WHERE tenant_id=$1 AND run_id=$2 AND state='PENDING_SEND'`,
      [tenantId, runId, replyMessageId],
    );
    if (updated.rowCount !== 1) throw new Error('business_run_mark_sent_failed');
  }

  async markFailed(tenantId: string, runId: string, error: string): Promise<void> {
    await tenantQuery(
      this.pool,
      tenantId,
      `UPDATE business_message_runs
       SET state='FAILED',last_error=$3,updated_at=now()
       WHERE tenant_id=$1 AND run_id=$2 AND state='PROCESSING'`,
      [tenantId, runId, error.slice(0, 1000)],
    );
  }
}
