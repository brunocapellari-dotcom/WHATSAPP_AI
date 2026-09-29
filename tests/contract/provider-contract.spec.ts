import { describe, expect, it } from 'vitest';
import type { WhatsAppProvider } from '../../src/domain/ports.js';
import { ProviderCapabilitiesSchema, RawMessageSchema } from '../../src/domain/schemas.js';
import { MetaCloudProvider } from '../../src/providers/meta-cloud-provider.js';
import { MockWhatsAppProvider } from '../../src/providers/mock-provider.js';
import { WppConnectProvider } from '../../src/providers/wppconnect-provider.js';

type ProviderFixture = {
  name: string;
  provider: WhatsAppProvider;
  payload: unknown;
};

const fixtures: ProviderFixture[] = [
  {
    name: 'mock',
    provider: new MockWhatsAppProvider(),
    payload: {
      messageId: 'contract-mock-1',
      accountId: 'mock-account',
      chatId: 'mock-chat',
      senderReference: 'mock-sender',
      text: 'SOJA frete R$ 180',
      timestamp: '2026-09-29T12:00:00Z',
    },
  },
  {
    name: 'meta-cloud',
    provider: new MetaCloudProvider({
      piiHmacKey: 'x'.repeat(32),
      graphVersion: 'v26.0',
    }),
    payload: {
      entry: [{
        id: 'waba',
        changes: [{
          value: {
            metadata: { phone_number_id: 'acct-1' },
            messages: [{
              id: 'wamid.contract.1',
              from: 'sender-1',
              timestamp: '1790683200',
              type: 'text',
              text: { body: 'SOJA frete R$ 180' },
            }],
          },
        }],
      }],
    },
  },
  {
    name: 'wppconnect',
    provider: new WppConnectProvider({
      baseUrl: 'https://wpp.example.test',
      apiToken: 'test-token',
      piiHmacKey: 'x'.repeat(32),
      session: 'contract',
    }),
    payload: {
      event: 'onmessage',
      id: { _serialized: 'false_sender@c.us_CONTRACT1' },
      from: 'sender@c.us',
      chatId: { _serialized: 'sender@c.us' },
      type: 'chat',
      timestamp: 1790683200,
      body: 'SOJA frete R$ 180',
    },
  },
];

describe.each(fixtures)('$name WhatsAppProvider contract', ({ provider, payload }) => {
  it('exposes a valid and explicit capability matrix', () => {
    expect(provider.id.length).toBeGreaterThan(0);
    expect(ProviderCapabilitiesSchema.parse(provider.capabilities)).toEqual(provider.capabilities);
  });

  it('normalizes inbound payloads into the canonical RawMessage contract', async () => {
    const messages = await provider.normalizeInbound(payload, {
      tenantId: 'tenant-contract',
      collectorId: 'collector-contract',
    });

    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      expect(() => RawMessageSchema.parse(message)).not.toThrow();
      expect(message.tenantId).toBe('tenant-contract');
      expect(message.collectorId).toBe('collector-contract');
      expect(message.provider).toBe(provider.id);
      expect(message.messageId.length).toBeGreaterThan(0);
      expect(message.contentHash.length).toBeGreaterThanOrEqual(16);
    }
  });

  it('preserves upstream message identity across replay', async () => {
    const context = { tenantId: 'tenant-contract', collectorId: 'collector-contract' };
    const first = await provider.normalizeInbound(payload, context);
    const replay = await provider.normalizeInbound(payload, context);

    expect(first.map((message) => message.messageId))
      .toEqual(replay.map((message) => message.messageId));
  });
});
