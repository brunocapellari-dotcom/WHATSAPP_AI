import type { Pool } from 'pg';
import type { MessageRepository } from '../domain/ports.js';
import { FreightEventSchema, type FreightEvent, type FreightObservation, type OutboxEvent, type RawMessage } from '../domain/schemas.js';
import { tenantQuery } from './tenant-db.js';

export class PostgresMessageRepository implements MessageRepository {
  constructor(private readonly pool: Pool) {}

  async saveRaw(message: RawMessage): Promise<'inserted' | 'duplicate'> {
    const result = await tenantQuery(
      this.pool, message.tenantId,
      `INSERT INTO raw_messages
       (event_id, tenant_id, provider, collector_id, account_id, message_id, chat_id, group_id, occurred_at, received_at,
        sender_reference, message_type, text_content, attachment_reference, reply_context, content_hash, source_payload, schema_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (tenant_id, provider, message_id) DO NOTHING`,
      [message.eventId, message.tenantId, message.provider, message.collectorId, message.accountId, message.messageId,
       message.chatId, message.groupId, message.occurredAt, message.receivedAt, message.senderReference, message.messageType,
       message.text, message.attachmentReference, message.replyContext, message.contentHash, null,
       message.schemaVersion],
    );
    return result.rowCount === 1 ? 'inserted' : 'duplicate';
  }

  async saveObservation(observation: FreightObservation): Promise<void> {
    await tenantQuery(
      this.pool, observation.tenantId,
      `INSERT INTO freight_observations
       (observation_id, tenant_id, event_id, source_message_id, chat_id, group_id, observed_at, fields, quality_score,
        issues, canonical, fingerprint, schema_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (observation_id) DO NOTHING`,
      [observation.observationId, observation.tenantId, observation.eventId, observation.sourceMessageId,
       observation.chatId, observation.groupId, observation.observedAt, observation.fields, observation.qualityScore,
       observation.issues, observation.canonical, observation.fingerprint, observation.schemaVersion],
    );
  }

  async findFreightEventByFingerprint(tenantId: string, fingerprint: string): Promise<FreightEvent | null> {
    const result = await tenantQuery<{ payload: unknown }>(
      this.pool, tenantId,
      `SELECT payload FROM freight_events WHERE tenant_id=$1 AND fingerprint=$2 LIMIT 1`,
      [tenantId, fingerprint],
    );
    return result.rows[0]?.payload ? FreightEventSchema.parse(result.rows[0].payload) : null;
  }

  async saveFreightEvent(event: FreightEvent): Promise<void> {
    await tenantQuery(
      this.pool, event.tenantId,
      `INSERT INTO freight_events
       (freight_event_id, tenant_id, fingerprint, first_seen_at, last_seen_at, duplicate_count, status, payload, schema_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (tenant_id, fingerprint) DO UPDATE SET
         last_seen_at=EXCLUDED.last_seen_at,
         duplicate_count=EXCLUDED.duplicate_count,
         status=EXCLUDED.status,
         payload=EXCLUDED.payload,
         schema_version=EXCLUDED.schema_version,
         updated_at=now()`,
      [event.freightEventId, event.tenantId, event.fingerprint, event.firstSeenAt, event.lastSeenAt, event.duplicateCount,
       event.status, event, event.schemaVersion],
    );
  }

  async enqueueOutbox(event: OutboxEvent): Promise<void> {
    await tenantQuery(
      this.pool, event.tenantId,
      `INSERT INTO outbox_events
       (outbox_id, tenant_id, topic, aggregate_id, idempotency_key, payload, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [event.outboxId, event.tenantId, event.topic, event.aggregateId, event.idempotencyKey, event.payload, event.createdAt],
    );
  }
}
