import type { WhatsAppProvider } from '../domain/ports.js';
import { RawMessageSchema, type ProviderCapabilities } from '../domain/schemas.js';
import { pseudonymize, sha256 } from '../security/crypto.js';
import { readResponseBytesLimited } from '../security/download.js';
import { ProviderSendError } from './errors.js';

export class WppConnectProvider implements WhatsAppProvider {
  readonly id = 'wppconnect';
  readonly capabilities: ProviderCapabilities = {
    receive: true,
    send: true,
    media: true,
    templates: false,
    managedGroups: true,
    existingGroups: true,
    historySync: true,
    receipts: true,
    reactions: true,
  };

  constructor(
    private readonly options: {
      baseUrl: string;
      apiToken: string;
      piiHmacKey: string;
      session: string;
    },
  ) {}

  async sendText(input: { tenantId: string; to: string; text: string }) {
    let response: Response;
    try {
      response = await fetch(
        `${this.options.baseUrl.replace(/\/$/, '')}/api/${encodeURIComponent(this.options.session)}/send-message`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.options.apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ phone: input.to, message: input.text }),
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch (cause) {
      throw new ProviderSendError('wpp_send_transport_failure', true, { cause });
    }

    if (!response.ok) {
      throw new ProviderSendError(`wpp_send_failed:${response.status}`, false);
    }

    const data = await response.json() as Record<string, unknown>;
    const messageId = String(data.id ?? data.messageId ?? '').trim();
    if (!messageId) {
      throw new ProviderSendError('wpp_send_missing_message_id', true);
    }
    return { messageId };
  }

  async normalizeInbound(input: unknown, context: { tenantId: string; collectorId: string }) {
    const body = input as Record<string, unknown>;
    const data = (body.data ?? body) as Record<string, unknown>;
    const from = String(data.from ?? data.sender ?? 'unknown');
    const providerMessageId = String(data.id ?? data.messageId ?? '').trim();
    const messageId = providerMessageId || `synthetic:${sha256(JSON.stringify(data)).slice(0, 48)}`;
    const routingChatId = String(data.chatId ?? data.from ?? 'unknown');
    const isGroup = routingChatId.endsWith('@g.us') || Boolean(data.isGroupMsg);
    const chatReference = pseudonymize(routingChatId, this.options.piiHmacKey);
    const groupReference = isGroup ? chatReference : null;
    const text = String(data.body ?? data.content ?? '').trim() || null;
    const messageType = data.type === 'image'
      ? 'image'
      : data.type === 'audio' || data.type === 'ptt'
        ? 'audio'
        : data.type === 'document'
          ? 'document'
          : 'text';

    return [RawMessageSchema.parse({
      eventId: crypto.randomUUID(),
      tenantId: context.tenantId,
      provider: this.id,
      collectorId: context.collectorId,
      accountId: this.options.session,
      messageId,
      chatId: chatReference,
      groupId: groupReference,
      occurredAt: data.timestamp ? new Date(Number(data.timestamp) * 1000) : new Date(),
      receivedAt: new Date(),
      senderReference: pseudonymize(from, this.options.piiHmacKey),
      routingAddress: isGroup ? routingChatId : from,
      messageType,
      text,
      attachmentReference: data.mediaId ? String(data.mediaId) : null,
      replyContext: null,
      contentHash: sha256(JSON.stringify({ messageId, from, text, type: data.type })),
      sourcePayload: data,
      schemaVersion: 1,
    })];
  }

  async downloadMedia(reference: string, options?: { maxBytes: number }) {
    const response = await fetch(
      `${this.options.baseUrl.replace(/\/$/, '')}/api/${encodeURIComponent(this.options.session)}/download-media`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messageId: reference }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) throw new Error(`wpp_media_download_failed:${response.status}`);
    const maxBytes = options?.maxBytes ?? 25 * 1024 * 1024;
    const encodedLimit = Math.ceil(maxBytes * 4 / 3) + 512 * 1024;
    const responseBytes = await readResponseBytesLimited(response, encodedLimit);
    const body = JSON.parse(new TextDecoder().decode(responseBytes)) as Record<string, unknown>;
    const base64 = String(body.base64 ?? body.data ?? body.result ?? '');
    const match = base64.match(/^data:([^;]+);base64,(.+)$/s);
    const mimeType = match?.[1] ?? String(body.mimetype ?? body.mimeType ?? 'application/octet-stream');
    const payload = match?.[2] ?? base64;
    if (!payload) throw new Error('wpp_media_missing_payload');
    const decoded = new Uint8Array(Buffer.from(payload, 'base64'));
    if (decoded.byteLength > maxBytes) throw new Error('file_too_large');
    return {
      bytes: decoded,
      mimeType,
      ...(body.filename ? { fileName: String(body.filename) } : {}),
    };
  }

  async health() {
    try {
      const response = await fetch(`${this.options.baseUrl.replace(/\/$/, '')}/health`, {
        headers: { Authorization: `Bearer ${this.options.apiToken}` },
        signal: AbortSignal.timeout(5_000),
      });
      return { ok: response.ok, details: { status: response.status } };
    } catch (error) {
      return {
        ok: false,
        details: { error: error instanceof Error ? error.message : 'unknown' },
      };
    }
  }
}
