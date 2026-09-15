import type { MessageRepository } from '../domain/ports.js';
import type { FreightEvent, FreightObservation, OutboxEvent, RawMessage } from '../domain/schemas.js';

export class MemoryMessageRepository implements MessageRepository {
  readonly raw = new Map<string, RawMessage>();
  readonly observations = new Map<string, FreightObservation>();
  readonly freightEvents = new Map<string, FreightEvent>();
  readonly outbox: OutboxEvent[] = [];

  async saveRaw(message: RawMessage): Promise<'inserted' | 'duplicate'> {
    const key = `${message.tenantId}:${message.provider}:${message.messageId}`;
    if (this.raw.has(key)) return 'duplicate';
    this.raw.set(key, message);
    return 'inserted';
  }

  async saveObservation(observation: FreightObservation): Promise<void> {
    this.observations.set(observation.observationId, observation);
  }

  async findFreightEventByFingerprint(tenantId: string, fingerprint: string): Promise<FreightEvent | null> {
    return this.freightEvents.get(`${tenantId}:${fingerprint}`) ?? null;
  }

  async saveFreightEvent(event: FreightEvent): Promise<void> {
    this.freightEvents.set(`${event.tenantId}:${event.fingerprint}`, event);
  }

  async enqueueOutbox(event: OutboxEvent): Promise<void> {
    if (!this.outbox.some((item) => item.idempotencyKey === event.idempotencyKey)) this.outbox.push(event);
  }
}
