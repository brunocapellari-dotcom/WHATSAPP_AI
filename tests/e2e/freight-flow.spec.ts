import { describe, expect, it } from 'vitest';
import { IngestionService } from '../../src/app/ingestion-service.js';
import { FreightPipeline } from '../../src/freight/pipeline.js';
import { CanonicalEntityResolver } from '../../src/freight/entity-resolution.js';
import { MemoryCollectorResolver } from '../../src/infra/collectors.js';
import { MemoryMessageRepository } from '../../src/infra/memory-repository.js';
import { MemoryQuarantineStore } from '../../src/infra/quarantine.js';
import { MockWhatsAppProvider } from '../../src/providers/mock-provider.js';

function fixture() {
  const repo = new MemoryMessageRepository();
  const quarantine = new MemoryQuarantineStore();
  const collectors = new MemoryCollectorResolver([{ collectorId: 'freight-1', tenantId: 'tenant-a', provider: 'mock', account: 'wa-1', purpose: 'FREIGHT_INTELLIGENCE', status: 'HEALTHY' }]);
  const provider = new MockWhatsAppProvider();
  const freight = new FreightPipeline(repo, new CanonicalEntityResolver());
  const service = new IngestionService(collectors, new Map([[provider.id, provider]]), quarantine, repo, freight);
  return { repo, quarantine, service };
}

describe('Freight Intelligence end to end', () => {
  it('normalizes, extracts, resolves, persists, deduplicates and creates AgroLog outbox events', async () => {
    const { repo, service } = fixture();
    const text = '🚛 SOJA\nOrigem: Roo/MT\nDestino: Sorriso/MT\nFrete R$ 162,00 + PED 12,00\nOferta: 174816\n2 vagas';
    const first = await service.ingest('mock', 'freight-1', { messageId: 'm1', chatId: 'g1', groupId: 'g1', text, timestamp: '2026-09-15T12:00:00-04:00' });
    const second = await service.ingest('mock', 'freight-1', { messageId: 'm2', chatId: 'g2', groupId: 'g2', text, timestamp: '2026-09-15T12:01:00-04:00' });

    expect(first[0]?.disposition).toBe('PROMOTED');
    expect(second[0]?.disposition).toBe('PROMOTED');
    expect(repo.raw.size).toBe(2);
    expect(repo.observations.size).toBe(2);
    expect(repo.freightEvents.size).toBe(1);
    const event = [...repo.freightEvents.values()][0]!;
    expect(event.duplicateCount).toBe(1);
    expect(event.revision).toBe(2);
    expect(event.scope).toBe('OBSERVED_OFFER');
    expect(event.observationIds).toHaveLength(2);
    expect(event.mergedFields.product.value).toBe('SOJA');
    expect(event.mergedFields.freightValue.value).toBe(162);
    expect(event.mergedFields.offerId.value).toBe('174816');
    expect(repo.outbox.filter((x) => x.topic === 'agrolog.freight_observation.v1')).toHaveLength(2);
    expect(repo.outbox.filter((x) => x.topic === 'agrolog.freight_event.v1')).toHaveLength(2);
  });


  it('preserves weak relevant observations without creating a logical market event', async () => {
    const { repo, service } = fixture();
    const rows = await service.ingest('mock', 'freight-1', {
      messageId: 'weak-1',
      chatId: 'g1',
      groupId: 'g1',
      text: 'SOJA disponível',
    });

    expect(rows[0]?.disposition).toBe('PROMOTED');
    expect(rows[0]?.freightEventId).toBeUndefined();
    expect(repo.observations.size).toBe(1);
    expect(repo.freightEvents.size).toBe(0);
    const observation = [...repo.observations.values()][0]!;
    expect(observation.issues).toContain('dedup:insufficient_identity');
    expect(repo.outbox.filter((x) => x.topic === 'agrolog.freight_observation.v1')).toHaveLength(1);
    expect(repo.outbox.filter((x) => x.topic === 'agrolog.freight_event.v1')).toHaveLength(0);
  });

  it('deduplicates equivalent structured offers across city aliases without offer id', async () => {
    const { repo, service } = fixture();
    await service.ingest('mock', 'freight-1', {
      messageId: 'alias-1',
      chatId: 'g1',
      groupId: 'g1',
      text: 'SOJA\nOrigem: Roo/MT\nDestino: Sorriso/MT\nFrete R$ 162,00',
    });
    await service.ingest('mock', 'freight-1', {
      messageId: 'alias-2',
      chatId: 'g2',
      groupId: 'g2',
      text: 'SOJA\nOrigem: Rondonópolis/MT\nDestino: Sorriso/MT\nFrete R$ 162,00',
    });

    expect(repo.observations.size).toBe(2);
    expect(repo.freightEvents.size).toBe(1);
    const event = [...repo.freightEvents.values()][0]!;
    expect(event.duplicateCount).toBe(1);
    expect(event.observationIds).toHaveLength(2);
  });

  it('discards irrelevant group chatter before governed raw storage', async () => {
    const { repo, quarantine, service } = fixture();
    const rows = await service.ingest('mock', 'freight-1', { messageId: 'noise-1', chatId: 'g1', groupId: 'g1', text: 'Bom dia pessoal, tudo bem?' });
    expect(rows[0]?.disposition).toBe('DISCARDED');
    expect(repo.raw.size).toBe(0);
    expect([...quarantine.rows.values()][0]?.disposition).toBe('DISCARDED');
  });

  it('is idempotent for the same provider message id even when replay reaches the domain pipeline', async () => {
    const { repo, service } = fixture();
    const payload = { messageId: 'same-id', chatId: 'g1', groupId: 'g1', text: 'SOJA\nOrigem: Sinop/MT\nDestino: Rondonópolis/MT\nFrete R$ 180,00' };
    const first = await service.ingest('mock', 'freight-1', payload);
    const firstEventId = first[0]?.freightEventId;
    const duplicate = await service.ingest('mock', 'freight-1', payload);

    expect(duplicate[0]?.disposition).toBe('DUPLICATE');
    expect(duplicate[0]?.freightEventId).toBe(firstEventId);
    expect(repo.raw.size).toBe(1);
    expect(repo.observations.size).toBe(1);
    expect(repo.freightEvents.size).toBe(1);

    const event = [...repo.freightEvents.values()][0]!;
    expect(event.duplicateCount).toBe(0);
    expect(event.revision).toBe(1);
    expect(event.observationIds).toHaveLength(1);
    expect(repo.outbox.filter((x) => x.topic === 'agrolog.freight_observation.v1')).toHaveLength(1);
    expect(repo.outbox.filter((x) => x.topic === 'agrolog.freight_event.v1')).toHaveLength(1);
  });

  it('keeps tenant deduplication isolated', async () => {
    const repo = new MemoryMessageRepository();
    const provider = new MockWhatsAppProvider();
    const freight = new FreightPipeline(repo, new CanonicalEntityResolver());
    const collectors = new MemoryCollectorResolver([
      { collectorId: 'a', tenantId: 'tenant-a', provider: 'mock', account: '1', purpose: 'FREIGHT_INTELLIGENCE', status: 'HEALTHY' },
      { collectorId: 'b', tenantId: 'tenant-b', provider: 'mock', account: '2', purpose: 'FREIGHT_INTELLIGENCE', status: 'HEALTHY' },
    ]);
    const service = new IngestionService(collectors, new Map([[provider.id, provider]]), new MemoryQuarantineStore(), repo, freight);
    const text = 'MILHO\nOrigem: Sinop/MT\nDestino: Rondonópolis/MT\nFrete R$ 190,00\nOferta: X999';
    await service.ingest('mock', 'a', { messageId: '1', text, chatId: 'g' });
    await service.ingest('mock', 'b', { messageId: '2', text, chatId: 'g' });
    expect(repo.freightEvents.size).toBe(2);
  });
});
