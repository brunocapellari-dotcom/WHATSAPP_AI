import { describe, expect, it } from 'vitest';
import { RawMessageSchema } from '../../src/domain/schemas.js';
import { minimizedSourceProvenance } from '../../src/security/provenance.js';

describe('privacy-minimized message provenance', () => {
  it('keeps technical lineage without copying sender/chat payload fields', () => {
    const message = RawMessageSchema.parse({
      eventId: '11111111-1111-4111-8111-111111111111',
      tenantId: 'tenant-a',
      provider: 'mock',
      collectorId: 'collector-a',
      accountId: 'account-a',
      messageId: 'provider-message-a',
      chatId: 'hmac:chat',
      groupId: 'hmac:group',
      occurredAt: '2026-09-29T12:00:00Z',
      receivedAt: '2026-09-29T12:00:01Z',
      senderReference: 'hmac:sender',
      routingAddress: 'routing-secret',
      messageType: 'text',
      text: 'conteudo',
      attachmentReference: null,
      replyContext: null,
      contentHash: '1234567890abcdef',
      sourcePayload: {
        from: 'sensitive-sender',
        chatId: 'sensitive-chat',
        body: 'sensitive-body',
      },
      schemaVersion: 1,
    });

    const provenance = minimizedSourceProvenance(message);
    const serialized = JSON.stringify(provenance);

    expect(provenance).toMatchObject({
      provider: 'mock',
      collectorId: 'collector-a',
      accountId: 'account-a',
      providerMessageId: 'provider-message-a',
      contentHash: '1234567890abcdef',
      isGroup: true,
      sourcePayloadRetainedInQuarantine: true,
    });
    expect(serialized).not.toContain('sensitive-sender');
    expect(serialized).not.toContain('sensitive-chat');
    expect(serialized).not.toContain('sensitive-body');
    expect(serialized).not.toContain('routing-secret');
  });
});
