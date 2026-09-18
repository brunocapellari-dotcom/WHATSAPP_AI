import { afterEach, describe, expect, it, vi } from 'vitest';
import { WppConnectProvider } from '../../src/providers/wppconnect-provider.js';

function provider() {
  return new WppConnectProvider({
    baseUrl: 'https://wpp.example.test',
    apiToken: 'token',
    piiHmacKey: 'x'.repeat(32),
    session: 'default',
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WPPConnect provider', () => {
  it('keeps replay idempotency when upstream does not provide a message id', async () => {
    const client = provider();
    const payload = {
      event: 'onmessage',
      from: '5565999999999@c.us',
      chatId: '120363000000000000@g.us',
      isGroupMsg: true,
      timestamp: 1789491600,
      type: 'chat',
      body: 'SOJA Origem: Sinop Destino: Rondonópolis Frete R$ 180',
    };

    const first = await client.normalizeInbound(payload, { tenantId: 't', collectorId: 'c' });
    const replay = await client.normalizeInbound(payload, { tenantId: 't', collectorId: 'c' });

    expect(first[0]?.messageId.startsWith('synthetic:')).toBe(true);
    expect(first[0]?.messageId).toBe(replay[0]?.messageId);
    expect(first[0]?.chatId.startsWith('hmac:')).toBe(true);
    expect(first[0]?.groupId?.startsWith('hmac:')).toBe(true);
    expect(first[0]?.chatId).not.toContain('120363000000000000@g.us');
    expect(first[0]?.routingAddress).toBe('120363000000000000@g.us');
  });

  it('extracts serialized object ids and uses the message id for media download', async () => {
    const client = provider();
    const rows = await client.normalizeInbound({
      event: 'onmessage',
      id: { _serialized: 'false_5565999999999@c.us_MEDIA01' },
      from: '5565999999999@c.us',
      chatId: { _serialized: '5565999999999@c.us' },
      type: 'document',
      isMedia: true,
      mimetype: 'application/pdf',
      body: '',
    }, { tenantId: 't', collectorId: 'c' });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.messageId).toBe('false_5565999999999@c.us_MEDIA01');
    expect(rows[0]?.attachmentReference).toBe('false_5565999999999@c.us_MEDIA01');
    expect(rows[0]?.chatId).not.toContain('5565999999999@c.us');
  });

  it('ignores non-message webhook events instead of fabricating inbound messages', async () => {
    const client = provider();
    expect(await client.normalizeInbound({
      event: 'status-find',
      status: 'isLogged',
      session: 'default',
    }, { tenantId: 't', collectorId: 'c' })).toEqual([]);
  });

  it('sends groups with isGroup and extracts the wrapped WPPConnect response id', async () => {
    let sentBody: Record<string, unknown> | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        status: 'success',
        response: [{
          id: { _serialized: 'true_120363000000000000@g.us_ABC123' },
        }],
        mapper: 'return',
      }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    });

    const client = provider();
    const sent = await client.sendText({
      tenantId: 't',
      to: '120363000000000000@g.us',
      text: 'Teste',
    });

    expect(sent.messageId).toBe('true_120363000000000000@g.us_ABC123');
    expect(sentBody).toMatchObject({
      phone: '120363000000000000@g.us',
      isGroup: true,
      message: 'Teste',
    });
  });

  it('uses the upstream /healthz endpoint', async () => {
    let calledUrl = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      calledUrl = String(url);
      return new Response(JSON.stringify({ status: 'UP' }), { status: 200 });
    });

    const status = await provider().health();
    expect(status.ok).toBe(true);
    expect(calledUrl).toBe('https://wpp.example.test/healthz');
  });

  it('advertises only capabilities implemented by this adapter', () => {
    const capabilities = provider().capabilities;
    expect(capabilities.existingGroups).toBe(true);
    expect(capabilities.historySync).toBe(false);
    expect(capabilities.receipts).toBe(false);
    expect(capabilities.reactions).toBe(false);
    expect(capabilities.managedGroups).toBe(false);
  });
});
