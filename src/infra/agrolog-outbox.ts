import { randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';

type ClaimedOutboxRow = {
  outbox_id: string;
  tenant_id: string;
  topic: string;
  aggregate_id: string;
  idempotency_key: string;
  payload: unknown;
  attempts: number;
};

async function claimBatch(
  pool: Pool,
  batchSize: number,
): Promise<{ lockToken: string; rows: ClaimedOutboxRow[] }> {
  const lockToken = randomUUID();
  const claim = await pool.query<ClaimedOutboxRow>(
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
     RETURNING
       o.outbox_id,o.tenant_id,o.topic,o.aggregate_id,o.idempotency_key,o.payload,o.attempts`,
    [batchSize, lockToken],
  );
  return { lockToken, rows: claim.rows };
}

async function markPublished(pool: Pool, outboxId: string, lockToken: string) {
  const result = await pool.query(
    `UPDATE outbox_events
     SET published_at=now(),last_error=NULL,locked_at=NULL,lock_token=NULL
     WHERE outbox_id=$1 AND lock_token=$2`,
    [outboxId, lockToken],
  );
  if (result.rowCount !== 1) throw new Error('outbox_lease_lost');
}

async function markFailed(
  pool: Pool,
  row: ClaimedOutboxRow,
  lockToken: string,
  error: unknown,
) {
  const attempts = Number(row.attempts ?? 0) + 1;
  const delaySeconds = Math.min(3600, 2 ** Math.min(attempts, 10));
  await pool.query(
    `UPDATE outbox_events
     SET attempts=$3,
         last_error=$4,
         next_attempt_at=now()+($5 || ' seconds')::interval,
         locked_at=NULL,
         lock_token=NULL
     WHERE outbox_id=$1 AND lock_token=$2`,
    [
      row.outbox_id,
      lockToken,
      attempts,
      error instanceof Error ? error.message.slice(0, 1000) : 'unknown',
      delaySeconds,
    ],
  );
}

function envelope(row: ClaimedOutboxRow) {
  return {
    schemaVersion: 1,
    topic: row.topic,
    tenantId: row.tenant_id,
    aggregateId: row.aggregate_id,
    idempotencyKey: row.idempotency_key,
    payload: row.payload,
    exportedAt: new Date().toISOString(),
  };
}

export interface OutboxPublisher {
  publishBatch(): Promise<{ published: number; failed: number }>;
}

export class AgroLogOutboxPublisher implements OutboxPublisher {
  constructor(
    private readonly pool: Pool,
    private readonly options: { gatewayUrl: string; token: string; batchSize?: number },
  ) {}

  async publishBatch(): Promise<{ published: number; failed: number }> {
    const { lockToken, rows } = await claimBatch(this.pool, this.options.batchSize ?? 50);
    let published = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        const response = await fetch(
          `${this.options.gatewayUrl.replace(/\/$/, '')}/v1/events`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.options.token}`,
              'Content-Type': 'application/json',
              'Idempotency-Key': row.idempotency_key,
            },
            body: JSON.stringify(envelope(row)),
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (!response.ok) {
          throw new Error(`agrolog_http_${response.status}:${(await response.text()).slice(0, 500)}`);
        }
        await markPublished(this.pool, row.outbox_id, lockToken);
        published++;
      } catch (error) {
        await markFailed(this.pool, row, lockToken, error);
        failed++;
      }
    }

    return { published, failed };
  }
}

export class LocalAgroLogOutboxPublisher implements OutboxPublisher {
  constructor(
    private readonly pool: Pool,
    private readonly options: { exportDir: string; batchSize?: number },
  ) {}

  async publishBatch(): Promise<{ published: number; failed: number }> {
    await mkdir(this.options.exportDir, { recursive: true, mode: 0o700 });
    const { lockToken, rows } = await claimBatch(this.pool, this.options.batchSize ?? 50);
    let published = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        const day = new Date().toISOString().slice(0, 10);
        const filePath = join(this.options.exportDir, `agrolog-events-${day}.ndjson`);
        const handle = await open(filePath, 'a', 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(envelope(row))}\n`, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }

        // Append-before-ack gives at-least-once delivery. A crash between fsync and
        // this update can create a duplicate line; the idempotencyKey is therefore
        // mandatory for every downstream importer.
        await markPublished(this.pool, row.outbox_id, lockToken);
        published++;
      } catch (error) {
        await markFailed(this.pool, row, lockToken, error);
        failed++;
      }
    }

    return { published, failed };
  }
}
