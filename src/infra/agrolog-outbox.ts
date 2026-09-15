import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export class AgroLogOutboxPublisher {
  constructor(private readonly pool: Pool, private readonly options: { gatewayUrl: string; token: string; batchSize?: number }) {}

  async publishBatch(): Promise<{ published: number; failed: number }> {
    const lockToken = randomUUID();
    const claim = await this.pool.query(
      `WITH candidates AS (
         SELECT outbox_id
         FROM outbox_events
         WHERE published_at IS NULL
           AND next_attempt_at <= now()
           AND (locked_at IS NULL OR locked_at < now() - interval '5 minutes')
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE outbox_events o
       SET locked_at=now(), lock_token=$2
       FROM candidates c
       WHERE o.outbox_id=c.outbox_id
       RETURNING o.outbox_id, o.tenant_id, o.topic, o.aggregate_id, o.idempotency_key, o.payload, o.attempts`,
      [this.options.batchSize ?? 50, lockToken],
    );

    let published = 0;
    let failed = 0;
    for (const row of claim.rows as Array<Record<string, unknown>>) {
      try {
        const response = await fetch(`${this.options.gatewayUrl.replace(/\/$/, '')}/v1/events`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.options.token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': String(row.idempotency_key),
          },
          body: JSON.stringify({
            topic: row.topic,
            tenantId: row.tenant_id,
            aggregateId: row.aggregate_id,
            idempotencyKey: row.idempotency_key,
            payload: row.payload,
          }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`agrolog_http_${response.status}:${(await response.text()).slice(0, 500)}`);
        await this.pool.query(
          `UPDATE outbox_events
           SET published_at=now(), last_error=NULL, locked_at=NULL, lock_token=NULL
           WHERE outbox_id=$1 AND lock_token=$2`,
          [row.outbox_id, lockToken],
        );
        published++;
      } catch (error) {
        const attempts = Number(row.attempts ?? 0) + 1;
        const delaySeconds = Math.min(3600, 2 ** Math.min(attempts, 10));
        await this.pool.query(
          `UPDATE outbox_events
           SET attempts=$3, last_error=$4, next_attempt_at=now()+($5 || ' seconds')::interval,
               locked_at=NULL, lock_token=NULL
           WHERE outbox_id=$1 AND lock_token=$2`,
          [row.outbox_id, lockToken, attempts, error instanceof Error ? error.message.slice(0, 1000) : 'unknown', delaySeconds],
        );
        failed++;
      }
    }
    return { published, failed };
  }
}
