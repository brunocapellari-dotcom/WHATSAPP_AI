import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { decryptJson, encryptJson, sha256 } from '../security/crypto.js';
import { tenantQuery } from './tenant-db.js';

type StoredEnvelope = { rawBodyBase64: string };

export type WebhookInboxItem = {
  ingressId: string;
  tenantId: string;
  provider: string;
  collectorId: string;
  attempts: number;
  payload: unknown;
};

export class WebhookInbox {
  constructor(
    private readonly pool: Pool,
    private readonly encryptionSecret: string,
  ) {}

  async accept(input: {
    tenantId: string;
    provider: string;
    collectorId: string;
    rawBody: Uint8Array;
  }): Promise<{ ingressId: string; inserted: boolean }> {
    const ingressId = randomUUID();
    const payloadHash = sha256(input.rawBody);
    const encrypted = encryptJson(
      { rawBodyBase64: Buffer.from(input.rawBody).toString('base64') } satisfies StoredEnvelope,
      this.encryptionSecret,
    );

    const inserted = await tenantQuery<{ ingress_id: string }>(
      this.pool,
      input.tenantId,
      `INSERT INTO webhook_inbox(
         ingress_id,tenant_id,provider,collector_id,payload_hash,encrypted_payload
       ) VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id,provider,collector_id,payload_hash) DO NOTHING
       RETURNING ingress_id`,
      [
        ingressId,
        input.tenantId,
        input.provider,
        input.collectorId,
        payloadHash,
        encrypted,
      ],
    );

    if (inserted.rowCount === 1) return { ingressId, inserted: true };

    const existing = await tenantQuery<{ ingress_id: string }>(
      this.pool,
      input.tenantId,
      `SELECT ingress_id
       FROM webhook_inbox
       WHERE tenant_id=$1 AND provider=$2 AND collector_id=$3 AND payload_hash=$4
       LIMIT 1`,
      [input.tenantId, input.provider, input.collectorId, payloadHash],
    );
    const existingId = existing.rows[0]?.ingress_id;
    if (!existingId) throw new Error('webhook_inbox_dedup_lookup_failed');
    return { ingressId: existingId, inserted: false };
  }

  async claimBatch(limit = 20): Promise<WebhookInboxItem[]> {
    const lockToken = randomUUID();
    const result = await this.pool.query<{
      ingress_id: string;
      tenant_id: string;
      provider: string;
      collector_id: string;
      attempts: number;
      encrypted_payload: Buffer;
    }>(
      `WITH candidates AS (
         SELECT ingress_id
         FROM webhook_inbox
         WHERE (
           (state='RECEIVED' AND next_attempt_at <= now())
           OR (state='PROCESSING' AND locked_at < now() - interval '5 minutes')
         )
         ORDER BY received_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE webhook_inbox w
       SET state='PROCESSING',
           attempts=w.attempts+1,
           locked_at=now(),
           lock_token=$2,
           updated_at=now()
       FROM candidates c
       WHERE w.ingress_id=c.ingress_id
       RETURNING
         w.ingress_id,w.tenant_id,w.provider,w.collector_id,w.attempts,w.encrypted_payload`,
      [limit, lockToken],
    );

    return result.rows.map((row) => {
      const envelope = decryptJson<StoredEnvelope>(row.encrypted_payload, this.encryptionSecret);
      const raw = Buffer.from(envelope.rawBodyBase64, 'base64').toString('utf8');
      return {
        ingressId: row.ingress_id,
        tenantId: row.tenant_id,
        provider: row.provider,
        collectorId: row.collector_id,
        attempts: row.attempts,
        payload: JSON.parse(raw) as unknown,
      };
    });
  }

  async complete(ingressId: string): Promise<void> {
    await this.pool.query(
      `UPDATE webhook_inbox
       SET state='DONE',
           processed_at=now(),
           locked_at=NULL,
           lock_token=NULL,
           last_error=NULL,
           updated_at=now()
       WHERE ingress_id=$1 AND state='PROCESSING'`,
      [ingressId],
    );
  }

  async fail(ingressId: string, attempts: number, error: string): Promise<void> {
    const terminal = attempts >= 8;
    const delaySeconds = Math.min(3600, 2 ** Math.min(attempts, 10));
    await this.pool.query(
      `UPDATE webhook_inbox
       SET state=$2,
           next_attempt_at=CASE WHEN $2='RECEIVED'
             THEN now()+($4 || ' seconds')::interval
             ELSE next_attempt_at
           END,
           locked_at=NULL,
           lock_token=NULL,
           last_error=$3,
           updated_at=now()
       WHERE ingress_id=$1 AND state='PROCESSING'`,
      [
        ingressId,
        terminal ? 'FAILED' : 'RECEIVED',
        error.slice(0, 1000),
        delaySeconds,
      ],
    );
  }

  async purgeExpired(now: Date = new Date()): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM webhook_inbox
       WHERE expires_at <= $1
       RETURNING ingress_id`,
      [now],
    );
    return result.rowCount ?? 0;
  }
}
