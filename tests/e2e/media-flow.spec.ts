import { describe, expect, it } from 'vitest';
import { IngestionService } from '../../src/app/ingestion-service.js';
import { FreightPipeline } from '../../src/freight/pipeline.js';
import { CanonicalEntityResolver } from '../../src/freight/entity-resolution.js';
import { MemoryCollectorResolver } from '../../src/infra/collectors.js';
import { MemoryMessageRepository } from '../../src/infra/memory-repository.js';
import { MemoryQuarantineStore } from '../../src/infra/quarantine.js';
import { MockWhatsAppProvider } from '../../src/providers/mock-provider.js';

class MediaMockProvider extends MockWhatsAppProvider {
  override async downloadMedia() {
    return { bytes: new TextEncoder().encode('dummy'), mimeType: 'text/plain', fileName: 'message.txt' };
  }
}

describe('multimodal ingestion', () => {
  it('extracts content after validation and feeds Freight Intelligence', async () => {
    const repo = new MemoryMessageRepository();
    const provider = new MediaMockProvider();
    const freight = new FreightPipeline(repo, new CanonicalEntityResolver());
    const collectors = new MemoryCollectorResolver([{ collectorId: 'm', tenantId: 't', provider: 'mock', account: 'a', purpose: 'FREIGHT_INTELLIGENCE', status: 'HEALTHY' }]);
    const media = {
      scanner: { async scan() { return { clean: true }; } },
      processor: { async extract() { return 'SOJA\nOrigem: Sinop/MT\nDestino: Rondonópolis/MT\nFrete R$ 180,00'; } },
      maxBytes: 1_000_000,
    };
    const service = new IngestionService(collectors, new Map([[provider.id, provider]]), new MemoryQuarantineStore(), repo, freight, media);
    const rows = await service.ingest('mock', 'm', { messageId: 'doc-1', chatId: 'g', groupId: 'g', text: '', messageType: 'document', attachmentReference: 'ref-1' });
    expect(rows[0]?.disposition).toBe('PROMOTED');
    expect(repo.observations.size).toBe(1);
    expect([...repo.observations.values()][0]?.fields.freightValue.value).toBe(180);
  });

  it('fails closed when malware scanning is unavailable or rejects the file', async () => {
    const repo = new MemoryMessageRepository();
    const provider = new MediaMockProvider();
    const freight = new FreightPipeline(repo, new CanonicalEntityResolver());
    const collectors = new MemoryCollectorResolver([{ collectorId: 'm', tenantId: 't', provider: 'mock', account: 'a', purpose: 'FREIGHT_INTELLIGENCE', status: 'HEALTHY' }]);
    const media = {
      scanner: { async scan(): Promise<{ clean: boolean }> { throw new Error('scanner_down'); } },
      processor: { async extract() { return 'should not run'; } },
      maxBytes: 1_000_000,
    };
    const service = new IngestionService(collectors, new Map([[provider.id, provider]]), new MemoryQuarantineStore(), repo, freight, media);
    const rows = await service.ingest('mock', 'm', { messageId: 'doc-2', chatId: 'g', groupId: 'g', text: '', messageType: 'document', attachmentReference: 'ref-2' });
    expect(rows[0]?.disposition).toBe('REJECTED:media_processing_failed');
    expect(repo.raw.size).toBe(0);
  });
});
