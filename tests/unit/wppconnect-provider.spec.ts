import { describe, expect, it } from 'vitest';
import { WppConnectProvider } from '../../src/providers/wppconnect-provider.js';

describe('WPPConnect provider normalization', () => {
  it('keeps replay idempotency when upstream does not provide a message id', async () => {
    const provider = new WppConnectProvider({
      baseUrl: 'https://wpp.example.test',
      apiToken: 'token',
      piiHmacKey: 'x'.repeat(32),
      session: 'default',
    });
    const payload = {
      data: {
        from: '5565999999999@c.us',
        chatId: '120363000000000000@g.us',
        isGroupMsg: true,
        timestamp: 1789491600,
        type: 'chat',
        body: 'SOJA Origem: Sinop Destino: Rondonópolis Frete R$ 180',
      },
    };

    const first = await provider.normalizeInbound(payload, { tenantId: 't', collectorId: 'c' });
    const replay = await provider.normalizeInbound(payload, { tenantId: 't', collectorId: 'c' });

    expect(first[0]?.messageId.startsWith('synthetic:')).toBe(true);
    expect(first[0]?.messageId).toBe(replay[0]?.messageId);
    expect(first[0]?.groupId).toBe('120363000000000000@g.us');
  });
});
