import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { QuarantineStore } from '../domain/ports.js';
import type { RawMessage } from '../domain/schemas.js';
import { encryptJson } from '../security/crypto.js';
import { tenantQuery } from './tenant-db.js';

export class MemoryQuarantineStore implements QuarantineStore {
  readonly rows = new Map<string, { message: RawMessage; disposition: string; expiresAt: Date }>();
  async put(message: RawMessage, expiresAt: Date) {
    this.rows.set(`${message.tenantId}:${message.provider}:${message.messageId}`, { message, disposition: 'PENDING', expiresAt });
  }
  async mark(message: RawMessage, disposition: 'PROMOTED' | 'DISCARDED' | 'REJECTED') {
    const key = `${message.tenantId}:${message.provider}:${message.messageId}`;
    const row = this.rows.get(key);
    if (row) row.disposition = disposition;
  }
}

export class EncryptedPostgresQuarantineStore implements QuarantineStore {
  constructor(private readonly pool: Pool, private readonly encryptionSecret: string) {}
  async put(message: RawMessage, expiresAt: Date) {
    const encrypted = encryptJson(message.sourcePayload ?? { text: message.text, messageType: message.messageType }, this.encryptionSecret, 'quarantine-message');
    await tenantQuery(
      this.pool, message.tenantId,
      `INSERT INTO quarantine_messages(quarantine_id, tenant_id, provider, provider_message_id, encrypted_payload, content_hash, expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id, provider, provider_message_id) DO NOTHING`,
      [randomUUID(), message.tenantId, message.provider, message.messageId, encrypted, message.contentHash, expiresAt],
    );
  }
  async mark(message: RawMessage, disposition: 'PROMOTED' | 'DISCARDED' | 'REJECTED') {
    await tenantQuery(
      this.pool, message.tenantId,
      `UPDATE quarantine_messages SET disposition=$1 WHERE tenant_id=$2 AND provider=$3 AND provider_message_id=$4`,
      [disposition, message.tenantId, message.provider, message.messageId],
    );
  }
}
