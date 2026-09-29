import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FreightEvent, FreightObservation, OutboxEvent } from '../../src/domain/schemas.js';
import { emptyFreightFields } from '../../src/freight/fields.js';
import { PostgresMessageRepository } from '../../src/infra/postgres-repository.js';

const databaseUrl = process.env.DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;

function outbox(input: {
  tenantId: string;
  topic: 'agrolog.freight_observation.v1' | 'agrolog.freight_event.v1';
  aggregateId: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}): OutboxEvent {
  return {
    outboxId: randomUUID(),
    tenantId: input.tenantId,
    topic: input.topic,
    aggregateId: input.aggregateId,
    idempotencyKey: input.idempotencyKey,
    payload: input.payload,
    createdAt: new Date(),
  };
}

run('transactional freight persistence', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const tenantIds: string[] = [];

  afterAll(async () => {
    for (const tenantId of tenantIds) {
      await pool.query('DELETE FROM outbox_events WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM freight_event_revisions WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM freight_events WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM freight_observations WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM raw_messages WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM tenants WHERE tenant_id=$1', [tenantId]);
    }
    await pool.end();
  });

  async function fixture() {
    const tenantId = `freight-tx-${randomUUID()}`;
    const eventId = randomUUID();
    const freightEventId = randomUUID();
    const fingerprint = `fp-${randomUUID()}`;
    tenantIds.push(tenantId);

    await pool.query('INSERT INTO tenants(tenant_id,name) VALUES($1,$2)', [tenantId, 'Freight transaction test']);
    await pool.query(
      `INSERT INTO raw_messages(
        event_id,tenant_id,provider,collector_id,account_id,message_id,chat_id,
        occurred_at,received_at,sender_reference,message_type,text_content,content_hash,schema_version
      ) VALUES($1,$2,'mock','collector-test','account-test',$3,'chat-test',now(),now(),'sender-test','text','SOJA frete','1234567890abcdef',1)`,
      [eventId, tenantId, `message-${randomUUID()}`],
    );

    const fields = emptyFreightFields();
    const observation: FreightObservation = {
      observationId: eventId,
      tenantId,
      eventId,
      sourceMessageId: `message-${eventId}`,
      chatId: 'chat-test',
      groupId: null,
      observedAt: new Date(),
      fields,
      qualityScore: 0.5,
      issues: [],
      canonical: {
        productId: null,
        originId: null,
        destinationId: null,
        companyId: null,
        shipperId: null,
        carrierId: null,
        loadingPlaceId: null,
        unloadingPlaceId: null,
        resolution: {
          product: null,
          origin: null,
          destination: null,
          company: null,
          shipper: null,
          carrier: null,
          loadingPlace: null,
          unloadingPlace: null,
        },
      },
      fingerprint,
      schemaVersion: 1,
    };

    const logicalEvent: FreightEvent = {
      freightEventId,
      tenantId,
      fingerprint,
      firstSeenAt: observation.observedAt,
      lastSeenAt: observation.observedAt,
      observationIds: [observation.observationId],
      mergedFields: fields,
      duplicateCount: 0,
      revision: 1,
      status: 'ACTIVE',
      schemaVersion: 1,
    };

    return { tenantId, eventId, freightEventId, fingerprint, observation, logicalEvent };
  }

  it('commits observation, event revision and both outbox rows together', async () => {
    const data = await fixture();
    const repository = new PostgresMessageRepository(pool);

    const observationOutbox = outbox({
      tenantId: data.tenantId,
      topic: 'agrolog.freight_observation.v1',
      aggregateId: data.observation.observationId,
      idempotencyKey: `test-observation-${data.observation.observationId}`,
      payload: { kind: 'observation' },
    });

    const saved = await repository.persistFreightResult({
      observation: data.observation,
      observationOutbox,
      event: {
        fingerprint: data.fingerprint,
        merge: () => data.logicalEvent,
        outbox: (event) => outbox({
          tenantId: data.tenantId,
          topic: 'agrolog.freight_event.v1',
          aggregateId: event.freightEventId,
          idempotencyKey: `test-event-${event.freightEventId}-revision-${event.revision}`,
          payload: { kind: 'event', revision: event.revision },
        }),
      },
    });

    expect(saved?.revision).toBe(1);

    const state = await pool.query(
      `SELECT
        (SELECT count(*)::int FROM freight_observations WHERE observation_id=$1) AS observations,
        (SELECT count(*)::int FROM freight_events WHERE freight_event_id=$2) AS events,
        (SELECT count(*)::int FROM freight_event_revisions WHERE freight_event_id=$2) AS revisions,
        (SELECT count(*)::int FROM outbox_events WHERE aggregate_id = ANY($3::text[])) AS outbox`,
      [data.eventId, data.freightEventId, [data.eventId, data.freightEventId]],
    );

    expect(state.rows[0]).toMatchObject({
      observations: 1,
      events: 1,
      revisions: 1,
      outbox: 2,
    });
  });

  it('rolls the whole unit back when the event outbox insert fails', async () => {
    const data = await fixture();
    const repository = new PostgresMessageRepository(pool);

    const observationOutbox = outbox({
      tenantId: data.tenantId,
      topic: 'agrolog.freight_observation.v1',
      aggregateId: data.observation.observationId,
      idempotencyKey: `rollback-observation-${data.observation.observationId}`,
      payload: { kind: 'observation' },
    });

    await expect(repository.persistFreightResult({
      observation: data.observation,
      observationOutbox,
      event: {
        fingerprint: data.fingerprint,
        merge: () => data.logicalEvent,
        outbox: (event) => outbox({
          tenantId: `missing-${randomUUID()}`,
          topic: 'agrolog.freight_event.v1',
          aggregateId: event.freightEventId,
          idempotencyKey: `rollback-event-${event.freightEventId}`,
          payload: { kind: 'event' },
        }),
      },
    })).rejects.toThrow();

    const state = await pool.query(
      `SELECT
        (SELECT count(*)::int FROM freight_observations WHERE observation_id=$1) AS observations,
        (SELECT count(*)::int FROM freight_events WHERE freight_event_id=$2) AS events,
        (SELECT count(*)::int FROM freight_event_revisions WHERE freight_event_id=$2) AS revisions,
        (SELECT count(*)::int FROM outbox_events WHERE idempotency_key=$3) AS outbox`,
      [data.eventId, data.freightEventId, observationOutbox.idempotencyKey],
    );

    expect(state.rows[0]).toMatchObject({
      observations: 0,
      events: 0,
      revisions: 0,
      outbox: 0,
    });
  });
});
