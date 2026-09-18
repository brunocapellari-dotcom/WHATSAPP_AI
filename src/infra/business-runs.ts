import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type {
  BusinessRunClaim,
  BusinessRunResult,
  BusinessRunStore,
} from '../domain/ports.js';
import type { RawMessage } from '../domain/schemas.js';
import { decryptJson, encryptJson } from '../security/crypto.js';
import { tenantQuery, withTenant } from './tenant-db.js';

type MemoryRun = {
  runId: string;
  tenantId: string;
  state: 'PROCESSING' | 'PENDING_SEND' | 'SENDING' | 'SENT' | 'FAILED' | 'DELIVERY_UNCERTAIN';
  result?: BusinessRunResult;
  replyMessageId?: string;
  sendAttempts: number;
};

export class MemoryBusinessRunStore implements BusinessRunStore {
  readonly rows = new Map<string, MemoryRun>();

  async claim(message: RawMessage, _conversationId: string): Promise<BusinessRunClaim> {
    const key = `${message.tenantId}:${message.provider}:${message.messageId}`;
    const existing = this.rows.get(key);
    if (!existing) {
      const runId = randomUUID();
      this.rows.set(key, {
        runId,
        tenantId: message.tenantId,
        state: 'PROCESSING',
        sendAttempts: 0,
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
    if (row.state !== 'PROCESSING' && row.state !== 'FAILED') {
      throw new Error('business_run_transition_failed');
    }
    row.result = result;
    row.state = 'PENDING_SEND';
  }

  async beginSend(_tenantId: string, runId: string) {
    const row = [...this.rows.values()].find((candidate) => candidate.runId === runId);
    if (!row || row.state !== 'PENDING_SEND') throw new Error('business_run_begin_send_failed');
    row.state = 'SENDING';
    row.sendAttempts++;
  }

  async markNoSendCompleted(_tenantId: string, runId: string) {
    const row = [...this.rows.values()].find((candidate) => candidate.runId === runId);
    if (!row || row.state !== 'PENDING_SEND') throw new Error('business_run_no_send_transition_failed');
    row.state = 'SENT';
  }

  async markSent(_tenantId: string, runId: string, replyMessageId?: string) {
    const row = [...this.rows.values()].find((candidate) => candidate.runId === runId);
    if (!row || row.state !== 'SENDING') throw new Error('business_run_not_found');
    if (replyMessageId) row.replyMessageId = replyMessageId;
    row.state = 'SENT';
  }

  async markSendRetryable(_tenantId: string, runId: string) {
    const row = [...this.rows.values()].find((candidate) => candidate.runId === runId);
    if (!row || row.state !== 'SENDING') throw new Error('business_run_retry_transition_failed');
    row.state = 'PENDING_SEND';
  }

  async markDeliveryUncertain(_tenantId: string, runId: string) {
    const row = [...this.rows.values()].find((candidate) => candidate.runId === runId);
    if (!row || row.state !== 'SENDING') throw new Error('business_run_uncertain_transition_failed');
    row.state = 'DELIVERY_UNCERTAIN';
  }

  async markFailed(_tenantId: string, runId: string) {
    const row = [...this.rows.values()].find((candidate) => candidate.runId === runId);
    if (!row) return;
    if (row.state === 'PROCESSING') row.state = 'FAILED';
  }
}

type DbRun = {
  run_id: string;
  state: 'PROCESSING' | 'PENDING_SEND' | 'SENDING' | 'SENT' | 'FAILED' | 'DELIVERY_UNCERTAIN';
  result_encrypted: Buffer | null;
  reply_message_id: string | null;
};

export class PostgresBusinessRunStore implements BusinessRunStore {
  constructor(
    private readonly pool: Pool,
    private readonly encryptionSecret: string,
  ) {}

  async claim(message: RawMessage, conversationId: string): Promise<BusinessRunClaim> {
    return withTenant(this.pool, message.tenantId, async (client) => {
      const proposedRunId = randomUUID();
      const inserted = await client.query<{ run_id: string }>(
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
        return { state: 'NEW' as const, runId: proposedRunId };
      }

      await client.query(
        `UPDATE business_message_runs
         SET state='FAILED',
             last_error='stale_processing_uncertain',
             updated_at=now()
         WHERE tenant_id=$1
           AND provider=$2
           AND source_message_id=$3
           AND state='PROCESSING'
           AND updated_at < now() - interval '2 minutes'`,
        [message.tenantId, message.provider, message.messageId],
      );

      await client.query(
        `UPDATE business_message_runs
         SET state='DELIVERY_UNCERTAIN',
             last_error='stale_sending_uncertain',
             updated_at=now()
         WHERE tenant_id=$1
           AND provider=$2
           AND source_message_id=$3
           AND state='SENDING'
           AND COALESCE(send_started_at,updated_at) < now() - interval '90 seconds'`,
        [message.tenantId, message.provider, message.messageId],
      );

      const existing = await client.query<DbRun>(
        `SELECT run_id,state,result_encrypted,reply_message_id
         FROM business_message_runs
         WHERE tenant_id=$1 AND provider=$2 AND source_message_id=$3
         LIMIT 1`,
        [message.tenantId, message.provider, message.messageId],
      );
      const row = existing.rows[0];
      if (!row) throw new Error('business_run_claim_failed');

      if (row.state === 'PENDING_SEND' || row.state === 'SENT') {
        if (!row.result_encrypted) throw new Error('business_run_missing_result');
        const result = decryptJson<BusinessRunResult>(
          row.result_encrypted,
          this.encryptionSecret,
        );
        if (row.state === 'PENDING_SEND') {
          return { state: 'PENDING_SEND' as const, runId: row.run_id, result };
        }
        return {
          state: 'SENT' as const,
          runId: row.run_id,
          result,
          ...(row.reply_message_id ? { replyMessageId: row.reply_message_id } : {}),
        };
      }

      return { state: row.state, runId: row.run_id } as BusinessRunClaim;
    });
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
           send_started_at=NULL,
           updated_at=now()
       WHERE tenant_id=$1 AND run_id=$2 AND state IN ('PROCESSING','FAILED')`,
      [tenantId, runId, encrypted],
    );
    if (updated.rowCount !== 1) throw new Error('business_run_transition_failed');
  }

  async beginSend(tenantId: string, runId: string): Promise<void> {
    const updated = await tenantQuery(
      this.pool,
      tenantId,
      `UPDATE business_message_runs
       SET state='SENDING',
           send_started_at=now(),
           send_attempts=send_attempts+1,
           last_error=NULL,
           updated_at=now()
       WHERE tenant_id=$1 AND run_id=$2 AND state='PENDING_SEND'`,
      [tenantId, runId],
    );
    if (updated.rowCount !== 1) throw new Error('business_run_begin_send_failed');
  }

  async markNoSendCompleted(tenantId: string, runId: string): Promise<void> {
    const updated = await tenantQuery(
      this.pool,
      tenantId,
      `UPDATE business_message_runs
       SET state='SENT',
           reply_message_id=NULL,
           last_error=NULL,
           send_started_at=NULL,
           updated_at=now()
       WHERE tenant_id=$1 AND run_id=$2 AND state='PENDING_SEND'`,
      [tenantId, runId],
    );
    if (updated.rowCount !== 1) throw new Error('business_run_no_send_transition_failed');
  }

  async markSent(tenantId: string, runId: string, replyMessageId?: string): Promise<void> {
    const updated = await tenantQuery(
      this.pool,
      tenantId,
      `UPDATE business_message_runs
       SET state='SENT',
           reply_message_id=$3,
           last_error=NULL,
           send_started_at=NULL,
           updated_at=now()
       WHERE tenant_id=$1 AND run_id=$2 AND state='SENDING'`,
      [tenantId, runId, replyMessageId ?? null],
    );
    if (updated.rowCount !== 1) throw new Error('business_run_mark_sent_failed');
  }

  async markSendRetryable(tenantId: string, runId: string, error: string): Promise<void> {
    const updated = await tenantQuery(
      this.pool,
      tenantId,
      `UPDATE business_message_runs
       SET state='PENDING_SEND',
           last_error=$3,
           send_started_at=NULL,
           updated_at=now()
       WHERE tenant_id=$1 AND run_id=$2 AND state='SENDING'`,
      [tenantId, runId, error.slice(0, 1000)],
    );
    if (updated.rowCount !== 1) throw new Error('business_run_retry_transition_failed');
  }

  async markDeliveryUncertain(tenantId: string, runId: string, error: string): Promise<void> {
    const updated = await tenantQuery(
      this.pool,
      tenantId,
      `UPDATE business_message_runs
       SET state='DELIVERY_UNCERTAIN',
           last_error=$3,
           updated_at=now()
       WHERE tenant_id=$1 AND run_id=$2 AND state='SENDING'`,
      [tenantId, runId, error.slice(0, 1000)],
    );
    if (updated.rowCount !== 1) throw new Error('business_run_uncertain_transition_failed');
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
