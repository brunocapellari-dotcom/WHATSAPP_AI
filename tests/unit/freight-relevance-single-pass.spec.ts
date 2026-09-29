import { describe, expect, it } from 'vitest';
import { IngestionService } from '../../src/app/ingestion-service.js';
import type { StructuredLanguageModel } from '../../src/domain/ports.js';
import { FreightPipeline } from '../../src/freight/pipeline.js';
import { CanonicalEntityResolver } from '../../src/freight/entity-resolution.js';
import { emptyFreightFields, field } from '../../src/freight/fields.js';
import { MemoryCollectorResolver } from '../../src/infra/collectors.js';
import { MemoryMessageRepository } from '../../src/infra/memory-repository.js';
import { MemoryQuarantineStore } from '../../src/infra/quarantine.js';
import { MockWhatsAppProvider } from '../../src/providers/mock-provider.js';

describe('freight relevance execution', () => {
  it('classifies a non-heuristic message only once before processing', async () => {
    let classifyCalls = 0;
    const llm: StructuredLanguageModel = {
      async classifyRelevance() {
        classifyCalls += 1;
        return { relevant: true, confidence: 0.99, reason: 'fixture' };
      },
      async extractFreight() {
        const fields = emptyFreightFields();
        fields.product = field('SOJA', 'fixture', 0.9, 'INFERIDO');
        fields.origin = field('Sinop/MT', 'fixture', 0.9, 'INFERIDO');
        fields.destination = field('Rondonópolis/MT', 'fixture', 0.9, 'INFERIDO');
        fields.freightValue = field(180, 'fixture', 0.9, 'INFERIDO');
        return fields;
      },
    };

    const repo = new MemoryMessageRepository();
    const provider = new MockWhatsAppProvider();
    const collectors = new MemoryCollectorResolver([{
      collectorId: 'freight-single-pass',
      tenantId: 'tenant-a',
      provider: 'mock',
      account: 'account-a',
      purpose: 'FREIGHT_INTELLIGENCE',
      status: 'HEALTHY',
    }]);
    const freight = new FreightPipeline(repo, new CanonicalEntityResolver(), llm);
    const service = new IngestionService(
      collectors,
      new Map([[provider.id, provider]]),
      new MemoryQuarantineStore(),
      repo,
      freight,
    );

    const result = await service.ingest('mock', 'freight-single-pass', {
      messageId: 'single-pass-1',
      chatId: 'group-a',
      text: 'oportunidade logística especial',
    });

    expect(result[0]?.disposition).toBe('PROMOTED');
    expect(classifyCalls).toBe(1);
  });
});
