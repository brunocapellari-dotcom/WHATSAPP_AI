import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ConversationStore, WhatsAppProvider } from '../domain/ports.js';
import { isProviderSendError } from '../providers/errors.js';

type FollowupRow = {
  followup_id: string;
  tenant_id: string;
  conversation_id: string | null;
  message_text: string | null;
  attempts: number;
};

export class FollowupDeliveryService {
  constructor(
    private readonly pool: Pool,
    private readonly providers: Map<string, WhatsAppProvider>,
    private readonly conversations: ConversationStore,
    private readonly options: {
      batchSize?: number;
      maxAttempts?: number;
      staleSendingMinutes?: number;
    } = {},
  ) {}

  async deliverBatch(): Promise<{
    sent: number;
    retrying: number;
    failed: number;
    uncertain: number;
  }> {
    await this.recoverStaleSending();

    const lockToken = randomUUID();
    const batchSize = this.options.batchSize ?? 25;
    const claim = await this.pool.query<FollowupRow>(
      `WITH candidates AS (
         SELECT followup_id
         FROM followups
         WHERE status='PENDING'
           AND due_at <= now()
           AND next_attempt_at <= now()
           AND (locked_at IS NULL OR locked_at < now() - interval '5 minutes')
         ORDER BY due_at,followup_id
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE followups f
       SET locked_at=now(),lock_token=$2
       FROM candidates c
       WHERE f.followup_id=c.followup_id
       RETURNING
         f.followup_id,f.tenant_id,f.conversation_id,f.message_text,f.attempts`,
      [batchSize, lockToken],
    );

    const summary = { sent: 0, retrying: 0, failed: 0, uncertain: 0 };

    for (const row of claim.rows) {
      try {
        if (!row.conversation_id || !row.message_text?.trim()) {
          await this.markTerminalFailure(
            row,
            lockToken,
            'followup_missing_delivery_context',
          );
          summary.failed++;
          continue;
        }

        const routing = await this.conversations.getRouting(
          row.tenant_id,
          row.conversation_id,
        );
        if (!routing) {
          const outcome = await this.markRetryable(
            row,
            lockToken,
            'followup_routing_unavailable',
          );
          summary[outcome]++;
          continue;
        }

        const provider = this.providers.get(routing.provider);
        if (!provider) {
          const outcome = await this.markRetryable(
            row,
            lockToken,
            `followup_provider_unavailable:${routing.provider}`,
          );
          summary[outcome]++;
          continue;
        }

        const began = await this.pool.query(
          `UPDATE followups
           SET status='SENDING',locked_at=now()
           WHERE followup_id=$1
             AND lock_token=$2
             AND status='PENDING'`,
          [row.followup_id, lockToken],
        );
        if (began.rowCount !== 1) {
          throw new Error('followup_lease_lost_before_send');
        }

        let sent: { messageId: string };
        try {
          sent = await provider.sendText({
            tenantId: row.tenant_id,
            to: routing.routingAddress,
            text: row.message_text,
          });
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : 'followup_provider_send_failed';

          if (isProviderSendError(error) && !error.deliveryUncertain) {
            const outcome = await this.markRetryable(
              row,
              lockToken,
              message,
              'SENDING',
            );
            summary[outcome]++;
            continue;
          }

          await this.markDeliveryUncertain(row, lockToken, message);
          summary.uncertain++;
          continue;
        }

        try {
          const done = await this.pool.query(
            `UPDATE followups
             SET status='DONE',
                 sent_message_id=$3,
                 last_error=NULL,
                 locked_at=NULL,
                 lock_token=NULL
             WHERE followup_id=$1
               AND lock_token=$2
               AND status='SENDING'`,
            [row.followup_id, lockToken, sent.messageId],
          );
          if (done.rowCount !== 1) {
            throw new Error('followup_ack_persistence_failed');
          }
          summary.sent++;
        } catch (error) {
          // SENDING is intentionally left durable if the database cannot record
          // provider acknowledgement. Recovery converts it to uncertainty rather
          // than risking an automatic duplicate.
          try {
            await this.markDeliveryUncertain(
              row,
              lockToken,
              `provider_acknowledged_but_persistence_failed:${sent.messageId}`,
            );
          } catch {
            // Preserve SENDING for stale recovery.
          }
          summary.uncertain++;
        }
      } catch (error) {
        // If delivery never started, the lock can safely return to retry.
        const current = await this.pool.query<{ status: string }>(
          'SELECT status FROM followups WHERE followup_id=$1',
          [row.followup_id],
        );
        if (current.rows[0]?.status === 'SENDING') {
          try {
            await this.markDeliveryUncertain(
              row,
              lockToken,
              error instanceof Error ? error.message : 'followup_unknown_after_send_start',
            );
          } catch {}
          summary.uncertain++;
        } else {
          const outcome = await this.markRetryable(
            row,
            lockToken,
            error instanceof Error ? error.message : 'followup_processing_failed',
          );
          summary[outcome]++;
        }
      }
    }

    return summary;
  }

  private async markRetryable(
    row: FollowupRow,
    lockToken: string,
    error: string,
    fromStatus = 'PENDING',
  ): Promise<'retrying' | 'failed'> {
    const attempts = Number(row.attempts ?? 0) + 1;
    const maxAttempts = this.options.maxAttempts ?? 8;

    if (attempts >= maxAttempts) {
      const result = await this.pool.query(
        `UPDATE followups
         SET status='FAILED',
             attempts=$3,
             last_error=$4,
             locked_at=NULL,
             lock_token=NULL
         WHERE followup_id=$1
           AND lock_token=$2
           AND status=$5`,
        [row.followup_id, lockToken, attempts, error.slice(0, 1000), fromStatus],
      );
      if (result.rowCount !== 1) throw new Error('followup_failure_transition_lost');
      await this.handoff(row, 'followup_delivery_failed');
      return 'failed';
    }

    const delaySeconds = Math.min(3600, 2 ** Math.min(attempts, 10) * 15);
    const result = await this.pool.query(
      `UPDATE followups
       SET status='PENDING',
           attempts=$3,
           last_error=$4,
           next_attempt_at=now()+($5 || ' seconds')::interval,
           locked_at=NULL,
           lock_token=NULL
       WHERE followup_id=$1
         AND lock_token=$2
         AND status=$6`,
      [
        row.followup_id,
        lockToken,
        attempts,
        error.slice(0, 1000),
        delaySeconds,
        fromStatus,
      ],
    );
    if (result.rowCount !== 1) throw new Error('followup_retry_transition_lost');
    return 'retrying';
  }

  private async markTerminalFailure(
    row: FollowupRow,
    lockToken: string,
    error: string,
  ) {
    const result = await this.pool.query(
      `UPDATE followups
       SET status='FAILED',
           last_error=$3,
           locked_at=NULL,
           lock_token=NULL
       WHERE followup_id=$1
         AND lock_token=$2
         AND status='PENDING'`,
      [row.followup_id, lockToken, error.slice(0, 1000)],
    );
    if (result.rowCount !== 1) throw new Error('followup_terminal_failure_transition_lost');
    await this.handoff(row, 'followup_delivery_context_invalid');
  }

  private async markDeliveryUncertain(
    row: FollowupRow,
    lockToken: string,
    error: string,
  ) {
    const result = await this.pool.query(
      `UPDATE followups
       SET status='DELIVERY_UNCERTAIN',
           attempts=attempts+1,
           last_error=$3,
           locked_at=NULL,
           lock_token=NULL
       WHERE followup_id=$1
         AND lock_token=$2
         AND status='SENDING'`,
      [row.followup_id, lockToken, error.slice(0, 1000)],
    );
    if (result.rowCount !== 1) throw new Error('followup_uncertain_transition_lost');
    await this.handoff(row, 'followup_delivery_uncertain');
  }

  private async handoff(row: FollowupRow, reason: string) {
    if (!row.conversation_id) return;
    await this.pool.query(
      `UPDATE conversations
       SET state='WAITING_HUMAN',
           assigned_to=NULL,
           metadata=metadata || $3::jsonb,
           updated_at=now()
       WHERE tenant_id=$1 AND conversation_id=$2`,
      [
        row.tenant_id,
        row.conversation_id,
        JSON.stringify({
          handoffReason: reason,
          followupId: row.followup_id,
        }),
      ],
    );
  }

  private async recoverStaleSending() {
    const minutes = Math.max(1, this.options.staleSendingMinutes ?? 5);
    const recovered = await this.pool.query<{
      followup_id: string;
      tenant_id: string;
      conversation_id: string | null;
    }>(
      `UPDATE followups
       SET status='DELIVERY_UNCERTAIN',
           last_error='stale_sending_uncertain',
           locked_at=NULL,
           lock_token=NULL
       WHERE status='SENDING'
         AND locked_at < now()-($1 || ' minutes')::interval
       RETURNING followup_id,tenant_id,conversation_id`,
      [minutes],
    );

    for (const row of recovered.rows) {
      if (!row.conversation_id) continue;
      await this.pool.query(
        `UPDATE conversations
         SET state='WAITING_HUMAN',
             assigned_to=NULL,
             metadata=metadata || $3::jsonb,
             updated_at=now()
         WHERE tenant_id=$1 AND conversation_id=$2`,
        [
          row.tenant_id,
          row.conversation_id,
          JSON.stringify({
            handoffReason: 'followup_stale_sending_uncertain',
            followupId: row.followup_id,
          }),
        ],
      );
    }
  }
}
