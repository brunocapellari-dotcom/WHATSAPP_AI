import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ConversationStore } from '../domain/ports.js';
import type { RawMessage } from '../domain/schemas.js';
import { decryptJson, encryptJson } from '../security/crypto.js';
import { tenantQuery } from './tenant-db.js';

export class MemoryConversationStore implements ConversationStore {
  readonly rows = new Map<string, {
    conversationId: string;
    tenantId: string;
    provider: string;
    chatId: string;
    routingAddress?: string;
  }>();

  async ensure(message: RawMessage) {
    const key = `${message.tenantId}:${message.provider}:${message.chatId}`;
    const existing = this.rows.get(key);
    if (existing) {
      if (message.routingAddress) existing.routingAddress = message.routingAddress;
      return { conversationId: existing.conversationId };
    }
    const conversationId = randomUUID();
    this.rows.set(key, {
      conversationId,
      tenantId: message.tenantId,
      provider: message.provider,
      chatId: message.chatId,
      ...(message.routingAddress ? { routingAddress: message.routingAddress } : {}),
    });
    return { conversationId };
  }

  async getRouting(tenantId: string, conversationId: string) {
    const row = [...this.rows.values()].find(
      (candidate) => candidate.tenantId === tenantId && candidate.conversationId === conversationId,
    );
    if (!row?.routingAddress) return null;
    return { provider: row.provider, routingAddress: row.routingAddress };
  }
}

export class PostgresConversationStore implements ConversationStore {
  constructor(
    private readonly pool: Pool,
    private readonly encryptionSecret: string,
  ) {}

  async ensure(message: RawMessage): Promise<{ conversationId: string }> {
    const conversationId = randomUUID();
    const encryptedRouting = message.routingAddress
      ? encryptJson({ routingAddress: message.routingAddress }, this.encryptionSecret)
      : null;

    const result = await tenantQuery<{ conversation_id: string }>(
      this.pool,
      message.tenantId,
      `INSERT INTO conversations(
         conversation_id,tenant_id,provider,provider_chat_id,routing_address_encrypted,last_message_at
       ) VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id,provider,provider_chat_id)
       DO UPDATE SET
         routing_address_encrypted=COALESCE(EXCLUDED.routing_address_encrypted,conversations.routing_address_encrypted),
         last_message_at=GREATEST(COALESCE(conversations.last_message_at,EXCLUDED.last_message_at),EXCLUDED.last_message_at),
         updated_at=now()
       RETURNING conversation_id`,
      [
        conversationId,
        message.tenantId,
        message.provider,
        message.chatId,
        encryptedRouting,
        message.occurredAt,
      ],
    );

    const id = result.rows[0]?.conversation_id;
    if (!id) throw new Error('conversation_upsert_failed');
    return { conversationId: id };
  }

  async getRouting(tenantId: string, conversationId: string) {
    const result = await tenantQuery<{
      provider: string;
      routing_address_encrypted: Buffer | null;
    }>(
      this.pool,
      tenantId,
      `SELECT provider,routing_address_encrypted
       FROM conversations
       WHERE tenant_id=$1 AND conversation_id=$2
       LIMIT 1`,
      [tenantId, conversationId],
    );

    const row = result.rows[0];
    if (!row?.routing_address_encrypted) return null;
    const decrypted = decryptJson<{ routingAddress?: string }>(
      row.routing_address_encrypted,
      this.encryptionSecret,
    );
    if (!decrypted.routingAddress) return null;
    return { provider: row.provider, routingAddress: decrypted.routingAddress };
  }
}
