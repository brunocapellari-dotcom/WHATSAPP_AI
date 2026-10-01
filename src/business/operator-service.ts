import type { Pool } from 'pg';
import type { AuditSink } from '../domain/ports.js';
import { tenantQuery } from '../infra/tenant-db.js';

export type OperatorConversationState = 'OPEN' | 'WAITING_HUMAN' | 'HUMAN' | 'CLOSED';

export class OperatorService {
  constructor(
    private readonly pool: Pool,
    private readonly audit: AuditSink,
  ) {}

  async list(input: {
    tenantId: string;
    state?: OperatorConversationState;
    limit?: number;
  }) {
    const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
    const values: unknown[] = [input.tenantId];
    const stateSql = input.state ? ' AND state=$2' : '';
    if (input.state) values.push(input.state);
    values.push(limit);
    const limitParam = values.length;

    const result = await tenantQuery<{
      conversation_id: string;
      provider: string;
      state: OperatorConversationState;
      assigned_to: string | null;
      last_message_at: Date | null;
      updated_at: Date;
      metadata: Record<string, unknown>;
    }>(
      this.pool,
      input.tenantId,
      `SELECT
         conversation_id,provider,state,assigned_to,last_message_at,updated_at,metadata
       FROM conversations
       WHERE tenant_id=$1${stateSql}
       ORDER BY
         CASE state WHEN 'WAITING_HUMAN' THEN 0 WHEN 'HUMAN' THEN 1 ELSE 2 END,
         COALESCE(last_message_at,updated_at) DESC
       LIMIT $${limitParam}`,
      values,
    );

    return result.rows.map((row) => ({
      conversationId: row.conversation_id,
      provider: row.provider,
      state: row.state,
      assignedTo: row.assigned_to,
      lastMessageAt: row.last_message_at,
      updatedAt: row.updated_at,
      metadata: row.metadata,
    }));
  }

  async detail(input: {
    tenantId: string;
    conversationId: string;
    messageLimit?: number;
  }) {
    const conversation = await tenantQuery<{
      conversation_id: string;
      provider: string;
      provider_chat_id: string;
      state: OperatorConversationState;
      assigned_to: string | null;
      last_message_at: Date | null;
      updated_at: Date;
      metadata: Record<string, unknown>;
    }>(
      this.pool,
      input.tenantId,
      `SELECT
         conversation_id,provider,provider_chat_id,state,assigned_to,last_message_at,updated_at,metadata
       FROM conversations
       WHERE tenant_id=$1 AND conversation_id=$2
       LIMIT 1`,
      [input.tenantId, input.conversationId],
    );

    const row = conversation.rows[0];
    if (!row) return null;

    const limit = Math.max(1, Math.min(input.messageLimit ?? 50, 200));
    const messages = await tenantQuery<{
      event_id: string;
      occurred_at: Date;
      sender_reference: string;
      message_type: string;
      text_content: string | null;
      attachment_reference: string | null;
      reply_context: unknown;
    }>(
      this.pool,
      input.tenantId,
      `SELECT
         event_id,occurred_at,sender_reference,message_type,text_content,
         attachment_reference,reply_context
       FROM raw_messages
       WHERE tenant_id=$1
         AND provider=$2
         AND chat_id=$3
       ORDER BY occurred_at DESC
       LIMIT $4`,
      [input.tenantId, row.provider, row.provider_chat_id, limit],
    );

    return {
      conversationId: row.conversation_id,
      provider: row.provider,
      state: row.state,
      assignedTo: row.assigned_to,
      lastMessageAt: row.last_message_at,
      updatedAt: row.updated_at,
      metadata: row.metadata,
      messages: messages.rows.reverse().map((message) => ({
        eventId: message.event_id,
        occurredAt: message.occurred_at,
        senderReference: message.sender_reference,
        messageType: message.message_type,
        text: message.text_content,
        hasAttachment: Boolean(message.attachment_reference),
        replyContext: message.reply_context,
      })),
    };
  }

  async claim(input: {
    tenantId: string;
    conversationId: string;
    operatorReference: string;
  }) {
    const result = await tenantQuery<{
      conversation_id: string;
      state: OperatorConversationState;
      assigned_to: string | null;
    }>(
      this.pool,
      input.tenantId,
      `UPDATE conversations
       SET state='HUMAN',assigned_to=$3,updated_at=now()
       WHERE tenant_id=$1
         AND conversation_id=$2
         AND state IN ('WAITING_HUMAN','HUMAN')
         AND (assigned_to IS NULL OR assigned_to=$3)
       RETURNING conversation_id,state,assigned_to`,
      [input.tenantId, input.conversationId, input.operatorReference],
    );

    const row = result.rows[0];
    if (!row) {
      const existing = await this.detail({
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        messageLimit: 1,
      });
      if (!existing) throw new Error('conversation_not_found');
      throw new Error('conversation_claim_conflict');
    }

    await this.audit.write({
      tenantId: input.tenantId,
      actor: `operator:${input.operatorReference}`,
      action: 'conversation_claim',
      outcome: 'ALLOW',
      target: input.conversationId,
    });

    return {
      conversationId: row.conversation_id,
      state: row.state,
      assignedTo: row.assigned_to,
    };
  }

  async transition(input: {
    tenantId: string;
    conversationId: string;
    operatorReference: string;
    action: 'release' | 'resume_ai' | 'close';
  }) {
    const target = input.action === 'release'
      ? { state: 'WAITING_HUMAN', assignedTo: null }
      : input.action === 'resume_ai'
        ? { state: 'OPEN', assignedTo: null }
        : { state: 'CLOSED', assignedTo: input.operatorReference };

    const result = await tenantQuery<{
      conversation_id: string;
      state: OperatorConversationState;
      assigned_to: string | null;
    }>(
      this.pool,
      input.tenantId,
      `UPDATE conversations
       SET state=$4,assigned_to=$5,updated_at=now()
       WHERE tenant_id=$1
         AND conversation_id=$2
         AND (
           assigned_to=$3
           OR (assigned_to IS NULL AND state='WAITING_HUMAN')
         )
       RETURNING conversation_id,state,assigned_to`,
      [
        input.tenantId,
        input.conversationId,
        input.operatorReference,
        target.state,
        target.assignedTo,
      ],
    );

    const row = result.rows[0];
    if (!row) {
      const existing = await this.detail({
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        messageLimit: 1,
      });
      if (!existing) throw new Error('conversation_not_found');
      throw new Error('conversation_operator_mismatch');
    }

    await this.audit.write({
      tenantId: input.tenantId,
      actor: `operator:${input.operatorReference}`,
      action: `conversation_${input.action}`,
      outcome: 'ALLOW',
      target: input.conversationId,
    });

    return {
      conversationId: row.conversation_id,
      state: row.state,
      assignedTo: row.assigned_to,
    };
  }
}
