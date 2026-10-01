import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { AuditSink, ConversationStore, WhatsAppProvider } from '../domain/ports.js';
import { isProviderSendError } from '../providers/errors.js';
import { encryptJson, sha256 } from '../security/crypto.js';
import { tenantQuery } from '../infra/tenant-db.js';

type OutboundState =
  | 'PENDING'
  | 'SENDING'
  | 'SENT'
  | 'FAILED'
  | 'DELIVERY_UNCERTAIN';

type OutboundRow = {
  outbound_id: string;
  conversation_id: string;
  request_id: string;
  operator_reference: string;
  content_hash: string;
  state: OutboundState;
  attempts: number;
  provider_message_id: string | null;
  last_error: string | null;
  send_started_at: Date | null;
  updated_at: Date;
};

export class OperatorOutboundService {
  constructor(
    private readonly pool: Pool,
    private readonly providers: Map<string, WhatsAppProvider>,
    private readonly conversations: ConversationStore,
    private readonly encryptionSecret: string,
    private readonly audit: AuditSink,
    private readonly staleSendingMs = 5 * 60 * 1000,
  ) {}

  async send(input: {
    tenantId: string;
    conversationId: string;
    operatorReference: string;
    requestId: string;
    text: string;
  }) {
    const normalizedText = input.text.trim();
    if (!normalizedText) throw new Error('operator_message_empty');
    const contentHash = sha256(normalizedText);

    const ownership = await tenantQuery<{
      state: string;
      assigned_to: string | null;
    }>(
      this.pool,
      input.tenantId,
      `SELECT state,assigned_to
       FROM conversations
       WHERE tenant_id=$1 AND conversation_id=$2
       LIMIT 1`,
      [input.tenantId, input.conversationId],
    );
    const conversation = ownership.rows[0];
    if (!conversation) throw new Error('conversation_not_found');
    if (conversation.state !== 'HUMAN' || conversation.assigned_to !== input.operatorReference) {
      throw new Error('conversation_not_owned_by_operator');
    }

    const outboundId = randomUUID();
    const encrypted = encryptJson({ text: normalizedText }, this.encryptionSecret, 'operator-outbound-text');

    await tenantQuery(
      this.pool,
      input.tenantId,
      `INSERT INTO operator_outbound_messages(
         outbound_id,tenant_id,conversation_id,request_id,operator_reference,
         content_hash,text_encrypted
       ) VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(tenant_id,request_id) DO NOTHING`,
      [
        outboundId,
        input.tenantId,
        input.conversationId,
        input.requestId,
        input.operatorReference,
        contentHash,
        encrypted,
      ],
    );

    let row = await this.getRow(input.tenantId, input.requestId);
    if (!row) throw new Error('operator_outbound_persistence_failed');
    if (row.content_hash !== contentHash || row.conversation_id !== input.conversationId) {
      throw new Error('operator_request_id_conflict');
    }
    if (row.operator_reference !== input.operatorReference) {
      throw new Error('operator_request_owner_conflict');
    }

    if (row.state === 'SENT') {
      return this.result(row);
    }
    if (row.state === 'DELIVERY_UNCERTAIN') {
      return this.result(row);
    }
    if (row.state === 'SENDING') {
      const started = row.send_started_at?.getTime() ?? row.updated_at.getTime();
      if (Date.now() - started < this.staleSendingMs) {
        throw new Error('operator_send_in_progress');
      }
      await this.markUncertain(
        input.tenantId,
        row.outbound_id,
        'stale_operator_sending_uncertain',
      );
      row = await this.getRow(input.tenantId, input.requestId);
      if (!row) throw new Error('operator_outbound_persistence_failed');
      return this.result(row);
    }

    const routing = await this.conversations.getRouting(
      input.tenantId,
      input.conversationId,
    );
    if (!routing) {
      await this.markFailed(
        input.tenantId,
        row.outbound_id,
        'operator_routing_unavailable',
      );
      throw new Error('operator_routing_unavailable');
    }

    const provider = this.providers.get(routing.provider);
    if (!provider) {
      await this.markFailed(
        input.tenantId,
        row.outbound_id,
        `operator_provider_unavailable:${routing.provider}`,
      );
      throw new Error(`operator_provider_unavailable:${routing.provider}`);
    }

    const began = await tenantQuery(
      this.pool,
      input.tenantId,
      `UPDATE operator_outbound_messages
       SET state='SENDING',
           attempts=attempts+1,
           send_started_at=now(),
           last_error=NULL,
           updated_at=now()
       WHERE tenant_id=$1
         AND outbound_id=$2
         AND state IN ('PENDING','FAILED')`,
      [input.tenantId, row.outbound_id],
    );
    if (began.rowCount !== 1) throw new Error('operator_send_transition_conflict');

    let sent: { messageId: string };
    try {
      sent = await provider.sendText({
        tenantId: input.tenantId,
        to: routing.routingAddress,
        text: normalizedText,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'operator_provider_send_failed';
      if (isProviderSendError(error) && !error.deliveryUncertain) {
        await this.markFailed(input.tenantId, row.outbound_id, message);
        throw error;
      }

      await this.markUncertain(input.tenantId, row.outbound_id, message);
      await this.audit.write({
        tenantId: input.tenantId,
        actor: `operator:${input.operatorReference}`,
        action: 'operator_message_delivery_uncertain',
        outcome: 'ERROR',
        target: row.outbound_id,
        metadata: { conversationId: input.conversationId },
      });
      const uncertain = await this.getRow(input.tenantId, input.requestId);
      if (!uncertain) throw new Error('operator_outbound_persistence_failed');
      return this.result(uncertain);
    }

    try {
      const completed = await tenantQuery(
        this.pool,
        input.tenantId,
        `UPDATE operator_outbound_messages
         SET state='SENT',
             provider_message_id=$3,
             last_error=NULL,
             send_started_at=NULL,
             updated_at=now()
         WHERE tenant_id=$1
           AND outbound_id=$2
           AND state='SENDING'`,
        [input.tenantId, row.outbound_id, sent.messageId],
      );
      if (completed.rowCount !== 1) throw new Error('operator_send_ack_persistence_failed');
    } catch (error) {
      // If provider acknowledgement cannot be persisted, never resend. Keep or
      // convert the durable SENDING state to uncertainty for manual review.
      try {
        await this.markUncertain(
          input.tenantId,
          row.outbound_id,
          `provider_acknowledged_but_persistence_failed:${sent.messageId}`,
        );
      } catch {}
      throw error;
    }

    await this.audit.write({
      tenantId: input.tenantId,
      actor: `operator:${input.operatorReference}`,
      action: 'operator_message_sent',
      outcome: 'ALLOW',
      target: row.outbound_id,
      metadata: {
        conversationId: input.conversationId,
        provider: routing.provider,
      },
    });

    const completed = await this.getRow(input.tenantId, input.requestId);
    if (!completed) throw new Error('operator_outbound_persistence_failed');
    return this.result(completed);
  }

  async status(tenantId: string, requestId: string) {
    const row = await this.getRow(tenantId, requestId);
    return row ? this.result(row) : null;
  }

  private async getRow(tenantId: string, requestId: string) {
    const result = await tenantQuery<OutboundRow>(
      this.pool,
      tenantId,
      `SELECT
         outbound_id,conversation_id,request_id,operator_reference,content_hash,
         state,attempts,provider_message_id,last_error,send_started_at,updated_at
       FROM operator_outbound_messages
       WHERE tenant_id=$1 AND request_id=$2
       LIMIT 1`,
      [tenantId, requestId],
    );
    return result.rows[0] ?? null;
  }

  private result(row: OutboundRow) {
    return {
      outboundId: row.outbound_id,
      requestId: row.request_id,
      state: row.state,
      attempts: row.attempts,
      providerMessageId: row.provider_message_id,
      lastError: row.last_error,
    };
  }

  private async markFailed(
    tenantId: string,
    outboundId: string,
    error: string,
  ) {
    await tenantQuery(
      this.pool,
      tenantId,
      `UPDATE operator_outbound_messages
       SET state='FAILED',
           last_error=$3,
           send_started_at=NULL,
           updated_at=now()
       WHERE tenant_id=$1
         AND outbound_id=$2
         AND state IN ('PENDING','SENDING')`,
      [tenantId, outboundId, error.slice(0, 1000)],
    );
  }

  private async markUncertain(
    tenantId: string,
    outboundId: string,
    error: string,
  ) {
    const result = await tenantQuery(
      this.pool,
      tenantId,
      `UPDATE operator_outbound_messages
       SET state='DELIVERY_UNCERTAIN',
           last_error=$3,
           send_started_at=NULL,
           updated_at=now()
       WHERE tenant_id=$1
         AND outbound_id=$2
         AND state='SENDING'`,
      [tenantId, outboundId, error.slice(0, 1000)],
    );
    if (result.rowCount !== 1) {
      const current = await tenantQuery<{ state: OutboundState }>(
        this.pool,
        tenantId,
        'SELECT state FROM operator_outbound_messages WHERE tenant_id=$1 AND outbound_id=$2',
        [tenantId, outboundId],
      );
      if (current.rows[0]?.state !== 'DELIVERY_UNCERTAIN') {
        throw new Error('operator_uncertain_transition_failed');
      }
    }
  }
}
