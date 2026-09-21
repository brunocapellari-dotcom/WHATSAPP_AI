import { describe, expect, it, vi } from 'vitest';
import { WppReconciliationService } from '../../src/app/wpp-reconciliation-service.js';
import { MemoryCollectorResolver } from '../../src/infra/collectors.js';
import type { WhatsAppProvider } from '../../src/domain/ports.js';

describe('WPP reconciliation durability', () => {
  it('persists the complete batch before marking any chat as seen', async () => {
    const order: string[] = [];
    const stored: Buffer[] = [];
    const inbox = {
      async accept(input: { rawBody: Uint8Array }) {
        order.push('persist');
        stored.push(Buffer.from(input.rawBody));
        return { ingressId: `i-${stored.length}`, inserted: true };
      },
    };

    const collectors = new MemoryCollectorResolver([{
      collectorId: 'wpp-freight-default',
      tenantId: 'tenant-a',
      provider: 'wppconnect',
      account: 'default',
      purpose: 'FREIGHT_INTELLIGENCE',
      status: 'HEALTHY',
    }]);

    const provider = {
      id: 'wppconnect',
      accountId: 'default',
      capabilities: {
        receive: true, send: true, media: true, templates: false,
        managedGroups: false, existingGroups: true, historySync: false,
        receipts: false, reactions: false,
      },
      async sendText() { return { messageId: 'unused' }; },
      async normalizeInbound() { return []; },
      async health() { return { ok: true }; },
      async fetchReconciliationBatch() {
        return [
          { payload: { id: 'm1' }, chatAddress: 'g1@g.us', isGroup: true },
          { payload: { id: 'm2' }, chatAddress: 'g2@g.us', isGroup: true },
        ];
      },
      async markChatSeen(chat: string) {
        order.push(`seen:${chat}`);
      },
    } satisfies WhatsAppProvider;

    const service = new WppReconciliationService(
      collectors,
      inbox as never,
      1024 * 1024,
    );

    const result = await service.run(provider, 'wpp-freight-default');

    expect(result).toEqual({
      fetched: 2,
      queued: 2,
      duplicates: 0,
      chatsMarkedSeen: 2,
    });
    expect(order).toEqual(['persist', 'persist', 'seen:g1@g.us', 'seen:g2@g.us']);
    expect(JSON.parse(stored[0]!.toString('utf8'))).toEqual({ id: 'm1' });
  });

  it('never marks chats seen when durable persistence fails', async () => {
    const seen = vi.fn();
    let calls = 0;
    const inbox = {
      async accept() {
        calls++;
        if (calls === 2) throw new Error('database_down');
        return { ingressId: 'i-1', inserted: true };
      },
    };
    const collectors = new MemoryCollectorResolver([{
      collectorId: 'wpp-freight-default',
      tenantId: 'tenant-a',
      provider: 'wppconnect',
      account: 'default',
      purpose: 'FREIGHT_INTELLIGENCE',
      status: 'HEALTHY',
    }]);
    const provider = {
      id: 'wppconnect',
      accountId: 'default',
      capabilities: {
        receive: true, send: true, media: true, templates: false,
        managedGroups: false, existingGroups: true, historySync: false,
        receipts: false, reactions: false,
      },
      async sendText() { return { messageId: 'unused' }; },
      async normalizeInbound() { return []; },
      async health() { return { ok: true }; },
      async fetchReconciliationBatch() {
        return [
          { payload: { id: 'm1' }, chatAddress: 'g1@g.us', isGroup: true },
          { payload: { id: 'm2' }, chatAddress: 'g2@g.us', isGroup: true },
        ];
      },
      markChatSeen: seen,
    } satisfies WhatsAppProvider;

    const service = new WppReconciliationService(collectors, inbox as never, 1024 * 1024);
    await expect(service.run(provider, 'wpp-freight-default')).rejects.toThrow('database_down');
    expect(seen).not.toHaveBeenCalled();
  });
});
