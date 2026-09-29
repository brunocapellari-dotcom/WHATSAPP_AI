import { randomUUID } from 'node:crypto';
import type { EntityResolver, MessageRepository, ResolvedEntity, StructuredLanguageModel } from '../domain/ports.js';
import type { FreightEvent, FreightFields, FreightObservation, RawMessage } from '../domain/schemas.js';
import { OutboxEventSchema } from '../domain/schemas.js';
import { deterministicUuid } from '../security/crypto.js';
import { freightIdentity } from './dedup.js';
import { extractFreight } from './extractor.js';
import { preferField } from './fields.js';
import { assessFreightQuality } from './quality.js';

function mergeFields(existing: FreightFields, incoming: FreightFields): FreightFields {
  const merged = { ...existing } as FreightFields;
  for (const key of Object.keys(existing) as Array<keyof FreightFields>) {
    (merged[key] as unknown) = preferField(existing[key] as never, incoming[key] as never);
  }
  return merged;
}

export class FreightPipeline {
  constructor(
    private readonly repo: MessageRepository,
    private readonly resolver: EntityResolver,
    private readonly llm?: StructuredLanguageModel,
  ) {}

  async isRelevant(message: RawMessage): Promise<boolean> {
    const text = message.text?.trim();
    if (!text) return false;

    const heuristic = /\b(frete|carga|embarque|origem|destino|ped[aá]gio|soja|milho|farelo|r\$)\b/i.test(text);
    if (heuristic) return true;
    if (!this.llm) return false;

    const result = await this.llm.classifyRelevance(text);
    return result.relevant && result.confidence >= 0.7;
  }

  async process(
    message: RawMessage,
  ): Promise<{ observation: FreightObservation; event?: FreightEvent } | null> {
    if (!(await this.isRelevant(message))) return null;

    const fields = await extractFreight(message.text ?? '', this.llm);
    const quality = assessFreightQuality(fields);

    const [
      origin,
      destination,
      company,
      shipper,
      carrier,
      loadingPlace,
      unloadingPlace,
      product,
    ] = await Promise.all([
      this.resolver.resolveCity(fields.origin.value, message.tenantId),
      this.resolver.resolveCity(fields.destination.value, message.tenantId),
      this.resolver.resolveCompany(fields.company.value, message.tenantId),
      this.resolver.resolveCompany(fields.shipper.value, message.tenantId),
      this.resolver.resolveCarrier(fields.carrier.value, message.tenantId),
      this.resolver.resolveFacility(fields.loadingPlace.value, message.tenantId),
      this.resolver.resolveFacility(fields.unloadingPlace.value, message.tenantId),
      this.resolver.resolveProduct(fields.product.value, message.tenantId),
    ]);

    const canonical = {
      productId: product?.id ?? null,
      originId: origin?.id ?? null,
      destinationId: destination?.id ?? null,
      companyId: company?.id ?? null,
      shipperId: shipper?.id ?? null,
      carrierId: carrier?.id ?? null,
      loadingPlaceId: loadingPlace?.id ?? null,
      unloadingPlaceId: unloadingPlace?.id ?? null,
      resolution: {
        product: product ? { method: product.matchMethod, confidence: product.confidence } : null,
        origin: origin ? { method: origin.matchMethod, confidence: origin.confidence } : null,
        destination: destination ? { method: destination.matchMethod, confidence: destination.confidence } : null,
        company: company ? { method: company.matchMethod, confidence: company.confidence } : null,
        shipper: shipper ? { method: shipper.matchMethod, confidence: shipper.confidence } : null,
        carrier: carrier ? { method: carrier.matchMethod, confidence: carrier.confidence } : null,
        loadingPlace: loadingPlace ? { method: loadingPlace.matchMethod, confidence: loadingPlace.confidence } : null,
        unloadingPlace: unloadingPlace ? { method: unloadingPlace.matchMethod, confidence: unloadingPlace.confidence } : null,
      },
    };

    const identity = freightIdentity({
      fields,
      contentHash: message.contentHash,
      canonical,
    });

    const resolutionEntries: Array<[string, ResolvedEntity | null]> = [
      ['origin', origin],
      ['destination', destination],
      ['company', company],
      ['shipper', shipper],
      ['carrier', carrier],
      ['loadingPlace', loadingPlace],
      ['unloadingPlace', unloadingPlace],
      ['product', product],
    ];
    const resolutionIssues = resolutionEntries.flatMap(([fieldName, resolved]) => {
      if (!resolved || resolved.matchMethod === 'EXACT') return [];
      return [`entity:${fieldName}:${resolved.matchMethod.toLowerCase()}`];
    });

    const baseIssues = [...quality.issues, ...resolutionIssues];
    const issues = identity.eventEligible
      ? baseIssues
      : [...baseIssues, 'dedup:insufficient_identity'];

    // raw_messages.event_id is stable across webhook retries. Reusing it as the
    // observation id makes every freight observation exactly-once per source message.
    const observation: FreightObservation = {
      observationId: message.eventId,
      tenantId: message.tenantId,
      eventId: message.eventId,
      sourceMessageId: message.messageId,
      chatId: message.chatId,
      groupId: message.groupId,
      observedAt: message.occurredAt,
      fields,
      qualityScore: quality.score,
      issues,
      canonical,
      fingerprint: identity.fingerprint,
      schemaVersion: 1,
    };

    const now = new Date();
    const observationOutbox = OutboxEventSchema.parse({
      outboxId: randomUUID(),
      tenantId: message.tenantId,
      topic: 'agrolog.freight_observation.v1',
      aggregateId: observation.observationId,
      idempotencyKey: `freight-observation:${observation.observationId}`,
      payload: structuredClone(observation) as unknown as Record<string, unknown>,
      createdAt: now,
    });

    if (!identity.eventEligible) {
      await this.repo.persistFreightResult({
        observation,
        observationOutbox,
      });
      return { observation };
    }

    const event = await this.repo.persistFreightResult({
      observation,
      observationOutbox,
      event: {
        fingerprint: identity.fingerprint,
        merge: (existing) => {
          if (existing?.observationIds.includes(observation.observationId)) {
            return existing;
          }

          if (existing) {
            const observationIds = [...existing.observationIds, observation.observationId];
            return {
              ...existing,
              lastSeenAt: message.occurredAt > existing.lastSeenAt
                ? message.occurredAt
                : existing.lastSeenAt,
              observationIds,
              duplicateCount: Math.max(0, observationIds.length - 1),
              revision: existing.revision + 1,
              mergedFields: mergeFields(existing.mergedFields, fields),
            };
          }

          return {
            freightEventId: deterministicUuid(
              `freight-event:${message.tenantId}:${identity.fingerprint}`,
            ),
            tenantId: message.tenantId,
            fingerprint: identity.fingerprint,
            firstSeenAt: message.occurredAt,
            lastSeenAt: message.occurredAt,
            observationIds: [observation.observationId],
            mergedFields: fields,
            duplicateCount: 0,
            revision: 1,
            status: 'ACTIVE',
            schemaVersion: 1,
          };
        },
        outbox: (nextEvent) => OutboxEventSchema.parse({
          outboxId: randomUUID(),
          tenantId: message.tenantId,
          topic: 'agrolog.freight_event.v1',
          aggregateId: nextEvent.freightEventId,
          idempotencyKey: `freight-event:${nextEvent.freightEventId}:revision:${nextEvent.revision}`,
          payload: structuredClone(nextEvent) as unknown as Record<string, unknown>,
          createdAt: now,
        }),
      },
    });

    if (!event) throw new Error('freight_event_persistence_failed');
    return { observation, event };
  }
}
