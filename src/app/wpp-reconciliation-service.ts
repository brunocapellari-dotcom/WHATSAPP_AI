import type { CollectorResolver, WhatsAppProvider } from '../domain/ports.js';
import type { WebhookInbox } from '../infra/webhook-inbox.js';

export type WppReconciliationResult = {
  fetched: number;
  queued: number;
  duplicates: number;
  chatsMarkedSeen: number;
};

export class WppReconciliationService {
  constructor(
    private readonly collectors: CollectorResolver,
    private readonly inbox: WebhookInbox,
    private readonly maxEnvelopeBytes: number,
  ) {}

  async run(
    provider: WhatsAppProvider,
    collectorId: string,
  ): Promise<WppReconciliationResult> {
    if (provider.id !== 'wppconnect') {
      throw new Error('reconciliation_provider_not_wppconnect');
    }
    if (!provider.fetchReconciliationBatch || !provider.markChatSeen) {
      throw new Error('wpp_reconciliation_not_supported');
    }

    const collector = await this.collectors.resolve(collectorId);
    if (!collector || collector.provider !== provider.id) {
      throw new Error('collector_not_found');
    }
    if (collector.status === 'DISABLED') {
      return { fetched: 0, queued: 0, duplicates: 0, chatsMarkedSeen: 0 };
    }
    if (provider.accountId && collector.account !== provider.accountId) {
      throw new Error('wpp_collector_account_mismatch');
    }

    const startedAt = performance.now();

    try {
      const batch = await provider.fetchReconciliationBatch();
      let queued = 0;
      let duplicates = 0;
      const chats = new Map<string, boolean>();

      for (const item of batch) {
        const rawBody = Buffer.from(JSON.stringify(item.payload), 'utf8');
        if (rawBody.byteLength > this.maxEnvelopeBytes) {
          throw new Error('wpp_reconciliation_envelope_too_large');
        }

        const accepted = await this.inbox.accept({
          tenantId: collector.tenantId,
          provider: provider.id,
          collectorId: collector.collectorId,
          rawBody,
        });
        if (accepted.inserted) queued++;
        else duplicates++;

        if (item.chatAddress) {
          chats.set(item.chatAddress, item.isGroup);
        }
      }

      // Only acknowledge chats after every fetched payload has reached durable storage.
      // If send-seen fails, the next reconciliation may re-fetch the same messages,
      // which is safe because the inbox and domain pipeline are idempotent.
      let chatsMarkedSeen = 0;
      for (const [chatAddress, isGroup] of chats) {
        await provider.markChatSeen(chatAddress, isGroup);
        chatsMarkedSeen++;
      }

      await this.collectors.recordSuccess?.(
        collector.collectorId,
        Math.round(performance.now() - startedAt),
        batch.length > 0 ? new Date() : undefined,
      );

      return {
        fetched: batch.length,
        queued,
        duplicates,
        chatsMarkedSeen,
      };
    } catch (error) {
      await this.collectors.recordFailure?.(
        collector.collectorId,
        Math.round(performance.now() - startedAt),
        error instanceof Error ? error.message : 'wpp_reconciliation_failed',
      );
      throw error;
    }
  }
}
