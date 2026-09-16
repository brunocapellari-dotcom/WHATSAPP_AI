import type { BusinessMessageHandler, CollectorResolver, ContentProcessor, MalwareScanner, MessageRepository, QuarantineStore, WhatsAppProvider } from '../domain/ports.js';
import type { RawMessage } from '../domain/schemas.js';
import type { FreightPipeline } from '../freight/pipeline.js';
import { validateAttachment } from '../security/attachments.js';

export class IngestionService {
  constructor(
    private readonly collectors: CollectorResolver,
    private readonly providers: Map<string, WhatsAppProvider>,
    private readonly quarantine: QuarantineStore,
    private readonly messages: MessageRepository,
    private readonly freight: FreightPipeline,
    private readonly media?: { processor: ContentProcessor; scanner: MalwareScanner; maxBytes: number },
    private readonly business?: BusinessMessageHandler,
  ) {}

  async ingest(providerId: string, collectorId: string, payload: unknown) {
    const collector = await this.collectors.resolve(collectorId);
    if (!collector || collector.provider !== providerId) throw new Error('collector_not_found');
    if (collector.status === 'DISABLED') throw new Error('collector_disabled');
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error('provider_not_configured');
    const normalized = await provider.normalizeInbound(payload, { tenantId: collector.tenantId, collectorId });
    const results: Array<{ message: RawMessage; disposition: string; freightEventId?: string; replyMessageId?: string; handoff?: boolean }> = [];

    for (const originalMessage of normalized) {
      let message = originalMessage;
      if (!message.text && message.attachmentReference && provider.downloadMedia && this.media) {
        try {
          const media = await provider.downloadMedia(message.attachmentReference);
          const validation = await validateAttachment({
            bytes: media.bytes,
            declaredMime: media.mimeType,
            maxBytes: this.media.maxBytes,
            scanner: this.media.scanner,
          });
          if (!validation.accepted || !validation.detectedMime) {
            const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
            await this.quarantine.put(message, expiresAt);
            await this.quarantine.mark(message, 'REJECTED');
            results.push({ message, disposition: `REJECTED:${validation.reason}` });
            continue;
          }
          const text = await this.media.processor.extract({
            ...media,
            mimeType: validation.detectedMime,
            messageType: message.messageType,
          });
          message = { ...message, text };
        } catch {
          const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
          await this.quarantine.put(message, expiresAt);
          await this.quarantine.mark(message, 'REJECTED');
          results.push({ message, disposition: 'REJECTED:media_processing_failed' });
          continue;
        }
      }
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await this.quarantine.put(message, expiresAt);
      if (collector.purpose === 'FREIGHT_INTELLIGENCE' && !(await this.freight.isRelevant(message))) {
        await this.quarantine.mark(message, 'DISCARDED');
        results.push({ message, disposition: 'DISCARDED' });
        continue;
      }
      const save = await this.messages.saveRaw(message);
      if (save === 'duplicate') {
        await this.quarantine.mark(message, 'DISCARDED');
        results.push({ message, disposition: 'DUPLICATE' });
        continue;
      }
      await this.quarantine.mark(message, 'PROMOTED');
      if (collector.purpose === 'FREIGHT_INTELLIGENCE') {
        const processed = await this.freight.process(message);
        results.push({ message, disposition: 'PROMOTED', ...(processed ? { freightEventId: processed.event.freightEventId } : {}) });
      } else if (this.business) {
        const handled = await this.business.handle(message, provider);
        results.push({ message, disposition: 'PROMOTED', ...(handled.replyMessageId ? { replyMessageId: handled.replyMessageId } : {}), handoff: handled.handoff });
      } else {
        results.push({ message, disposition: 'PROMOTED' });
      }
    }
    return results;
  }
}
