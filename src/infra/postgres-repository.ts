import type { Pool, PoolClient } from 'pg';
import type { MessageRepository, PersistFreightResultInput } from '../domain/ports.js';
import {
  FreightEventSchema,
  type FreightEvent,
  type FreightObservation,
  type OutboxEvent,
  type RawMessage,
} from '../domain/schemas.js';
import { tenantQuery, withTenant } from './tenant-db.js';

async function insertObservation(client: PoolClient, observation: FreightObservation): Promise<void> {
  await client.query(
    `INSERT INTO freight_observations
     (observation_id, tenant_id, event_id, source_message_id, chat_id, group_id, observed_at, fields, quality_score,
      issues, canonical, fingerprint, schema_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (observation_id) DO NOTHING`,
    [
      observation.observationId,
      observation.tenantId,
      observation.eventId,
      observation.sourceMessageId,
      observation.chatId,
      observation.groupId,
      observation.observedAt,
      observation.fields,
      observation.qualityScore,
      observation.issues,
      observation.canonical,
      observation.fingerprint,
      observation.schemaVersion,
    ],
  );
}

async function insertOutbox(client: PoolClient, event: OutboxEvent): Promise<void> {
  await client.query(
    `INSERT INTO outbox_events
     (outbox_id, tenant_id, topic, aggregate_id, idempotency_key, payload, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      event.outboxId,
      event.tenantId,
      event.topic,
      event.aggregateId,
      event.idempotencyKey,
      event.payload,
      event.createdAt,
    ],
  );
}

async function upsertFreightEvent(client: PoolClient, event: FreightEvent): Promise<void> {
  await client.query(
    `INSERT INTO freight_events
     (freight_event_id, tenant_id, fingerprint, first_seen_at, last_seen_at, duplicate_count, revision, status, payload, schema_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (tenant_id, fingerprint) DO UPDATE SET
       last_seen_at=EXCLUDED.last_seen_at,
       duplicate_count=EXCLUDED.duplicate_count,
       revision=EXCLUDED.revision,
       status=EXCLUDED.status,
       payload=EXCLUDED.payload,
       schema_version=EXCLUDED.schema_version,
       updated_at=now()`,
    [
      event.freightEventId,
      event.tenantId,
      event.fingerprint,
      event.firstSeenAt,
      event.lastSeenAt,
      event.duplicateCount,
      event.revision,
      event.status,
      event,
      event.schemaVersion,
    ],
  );
}

async function insertFreightRevision(client: PoolClient, event: FreightEvent): Promise<void> {
  await client.query(
    `INSERT INTO freight_event_revisions
     (freight_event_id, tenant_id, revision, payload)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (freight_event_id, revision) DO NOTHING`,
    [event.freightEventId, event.tenantId, event.revision, event],
  );
}

export class PostgresMessageRepository implements MessageRepository {
  constructor(private readonly pool: Pool) {}

  async saveRaw(message: RawMessage): Promise<{ status: 'inserted' | 'duplicate'; eventId: string }> {
    return withTenant(this.pool, message.tenantId, async (client) => {
      const inserted = await client.query<{ event_id: string }>(
        `INSERT INTO raw_messages
         (event_id, tenant_id, provider, collector_id, account_id, message_id, chat_id, group_id, occurred_at, received_at,
          sender_reference, message_type, text_content, attachment_reference, reply_context, content_hash, source_payload, schema_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (tenant_id, provider, message_id) DO NOTHING
         RETURNING event_id`,
        [
          message.eventId,
          message.tenantId,
          message.provider,
          message.collectorId,
          message.accountId,
          message.messageId,
          message.chatId,
          message.groupId,
          message.occurredAt,
          message.receivedAt,
          message.senderReference,
          message.messageType,
          message.text,
          message.attachmentReference,
          message.replyContext,
          message.contentHash,
          null,
          message.schemaVersion,
        ],
      );

      const insertedId = inserted.rows[0]?.event_id;
      if (insertedId) return { status: 'inserted' as const, eventId: insertedId };

      const existing = await client.query<{ event_id: string }>(
        `SELECT event_id
         FROM raw_messages
         WHERE tenant_id=$1 AND provider=$2 AND message_id=$3
         LIMIT 1`,
        [message.tenantId, message.provider, message.messageId],
      );
      const eventId = existing.rows[0]?.event_id;
      if (!eventId) throw new Error('raw_message_dedup_lookup_failed');
      return { status: 'duplicate' as const, eventId };
    });
  }

  async saveObservation(observation: FreightObservation): Promise<void> {
    await withTenant(this.pool, observation.tenantId, (client) =>
      insertObservation(client, observation),
    );
  }

  async findFreightEventByFingerprint(
    tenantId: string,
    fingerprint: string,
  ): Promise<FreightEvent | null> {
    const result = await tenantQuery<{ payload: unknown }>(
      this.pool,
      tenantId,
      'SELECT payload FROM freight_events WHERE tenant_id=$1 AND fingerprint=$2 LIMIT 1',
      [tenantId, fingerprint],
    );
    return result.rows[0]?.payload ? FreightEventSchema.parse(result.rows[0].payload) : null;
  }

  async saveFreightEvent(event: FreightEvent): Promise<void> {
    await withTenant(this.pool, event.tenantId, async (client) => {
      await upsertFreightEvent(client, event);
      await insertFreightRevision(client, event);
    });
  }

  async mergeFreightEvent(
    tenantId: string,
    fingerprint: string,
    merge: (existing: FreightEvent | null) => FreightEvent,
  ): Promise<FreightEvent> {
    return withTenant(this.pool, tenantId, async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`freight:${tenantId}:${fingerprint}`],
      );

      const existingResult = await client.query<{ payload: unknown }>(
        `SELECT payload
         FROM freight_events
         WHERE tenant_id=$1 AND fingerprint=$2
         LIMIT 1
         FOR UPDATE`,
        [tenantId, fingerprint],
      );
      const existing = existingResult.rows[0]?.payload
        ? FreightEventSchema.parse(existingResult.rows[0].payload)
        : null;
      const next = FreightEventSchema.parse(merge(existing));

      await upsertFreightEvent(client, next);
      await insertFreightRevision(client, next);
      return next;
    });
  }

  async enqueueOutbox(event: OutboxEvent): Promise<void> {
    await withTenant(this.pool, event.tenantId, (client) => insertOutbox(client, event));
  }

  async persistFreightResult(input: PersistFreightResultInput): Promise<FreightEvent | null> {
    const tenantId = input.observation.tenantId;
    return withTenant(this.pool, tenantId, async (client) => {
      await insertObservation(client, input.observation);
      await insertOutbox(client, input.observationOutbox);

      if (!input.event) return null;

      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`freight:${tenantId}:${input.event.fingerprint}`],
      );

      const existingResult = await client.query<{ payload: unknown }>(
        `SELECT payload
         FROM freight_events
         WHERE tenant_id=$1 AND fingerprint=$2
         LIMIT 1
         FOR UPDATE`,
        [tenantId, input.event.fingerprint],
      );
      const existing = existingResult.rows[0]?.payload
        ? FreightEventSchema.parse(existingResult.rows[0].payload)
        : null;
      const next = FreightEventSchema.parse(input.event.merge(existing));

      await upsertFreightEvent(client, next);
      await insertFreightRevision(client, next);
      await insertOutbox(client, input.event.outbox(next));
      return next;
    });
  }
}
