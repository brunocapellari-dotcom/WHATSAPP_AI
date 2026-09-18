import { randomUUID } from 'node:crypto';
import type { WhatsAppProvider } from '../domain/ports.js';
import { RawMessageSchema, type ProviderCapabilities, type RawMessage } from '../domain/schemas.js';
import { pseudonymize, sha256 } from '../security/crypto.js';

type MetaProviderOptions = {
  accessToken?: string;
  phoneNumberId?: string;
  piiHmacKey: string;
  groupsEnabled?: boolean;
  graphVersion?: string;
};

export class MetaCloudProvider implements WhatsAppProvider {
  readonly id = 'meta-cloud';
  readonly capabilities: ProviderCapabilities;
  private readonly graphVersion: string;

  constructor(private readonly options: MetaProviderOptions) {
    this.graphVersion = options.graphVersion ?? 'v26.0';
    this.capabilities = {
      receive: true,
      send: Boolean(options.accessToken && options.phoneNumberId),
      media: true,
      templates: true,
      managedGroups: Boolean(options.groupsEnabled),
      existingGroups: false,
      historySync: false,
      receipts: true,
      reactions: true,
    };
  }

  async sendText(input: { tenantId: string; to: string; text: string }) {
    if (!this.options.accessToken || !this.options.phoneNumberId) throw new Error('meta_provider_not_configured');
    const isGroup = input.to.startsWith('group:');
    if (isGroup && !this.options.groupsEnabled) throw new Error('meta_groups_not_enabled');
    const recipient = isGroup ? input.to.slice('group:'.length) : input.to;
    const response = await fetch(
      `https://graph.facebook.com/${this.graphVersion}/${this.options.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: isGroup ? 'group' : 'individual',
          to: recipient,
          type: 'text',
          text: { body: input.text },
        }),
      },
    );
    if (!response.ok) throw new Error(`meta_send_failed:${response.status}:${await response.text()}`);
    const data = await response.json() as { messages?: Array<{ id?: string }> };
    const messageId = data.messages?.[0]?.id;
    if (!messageId) throw new Error('meta_send_missing_message_id');
    return { messageId };
  }

  async normalizeInbound(
    input: unknown,
    context: { tenantId: string; collectorId: string },
  ): Promise<RawMessage[]> {
    const payload = input as { entry?: Array<{ id?: string; changes?: Array<{ value?: Record<string, unknown> }> }> };
    const output: RawMessage[] = [];

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};
        const metadata = (value.metadata ?? {}) as Record<string, unknown>;
        const messages = Array.isArray(value.messages) ? value.messages as Array<Record<string, unknown>> : [];

        for (const message of messages) {
          const type = String(message.type ?? 'unknown');
          const text = type === 'text'
            ? String((message.text as Record<string, unknown> | undefined)?.body ?? '')
            : null;
          const from = String(message.from ?? 'unknown');
          const chat = (message.chat ?? {}) as Record<string, unknown>;
          const groupId = String(chat.id ?? message.group_id ?? '').trim() || null;
          const providerMessageId = String(message.id ?? '').trim();
          const messageId = providerMessageId || `synthetic:${sha256(JSON.stringify({
            entryId: entry.id ?? null,
            metadata,
            message,
          })).slice(0, 48)}`;
          const timestamp = message.timestamp ? new Date(Number(message.timestamp) * 1000) : new Date();
          const attachmentId = ['audio', 'image', 'document', 'video'].includes(type)
            ? String((message[type] as Record<string, unknown> | undefined)?.id ?? '') || null
            : null;
          const mappedType = type === 'document'
            ? 'document'
            : type === 'audio'
              ? 'audio'
              : type === 'image'
                ? 'image'
                : type === 'text'
                  ? 'text'
                  : type === 'location'
                    ? 'location'
                    : 'unknown';

          output.push(RawMessageSchema.parse({
            eventId: randomUUID(),
            tenantId: context.tenantId,
            provider: this.id,
            collectorId: context.collectorId,
            accountId: String(metadata.phone_number_id ?? entry.id ?? 'unknown'),
            messageId,
            chatId: groupId ?? from,
            groupId,
            occurredAt: timestamp,
            receivedAt: new Date(),
            senderReference: pseudonymize(from, this.options.piiHmacKey),
            routingAddress: groupId ? `group:${groupId}` : from,
            messageType: mappedType,
            text,
            attachmentReference: attachmentId,
            replyContext: message.context ?? null,
            contentHash: sha256(JSON.stringify({ messageId, from, type, text, attachmentId })),
            sourcePayload: message,
            schemaVersion: 1,
          }));
        }
      }
    }

    return output;
  }

  async downloadMedia(reference: string) {
    if (!this.options.accessToken) throw new Error('meta_provider_not_configured');
    const meta = await fetch(
      `https://graph.facebook.com/${this.graphVersion}/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${this.options.accessToken}` } },
    );
    if (!meta.ok) throw new Error(`meta_media_metadata_failed:${meta.status}`);
    const info = await meta.json() as { url?: string; mime_type?: string };
    if (!info.url) throw new Error('meta_media_missing_url');

    const file = await fetch(info.url, {
      headers: { Authorization: `Bearer ${this.options.accessToken}` },
      redirect: 'error',
    });
    if (!file.ok) throw new Error(`meta_media_download_failed:${file.status}`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    return {
      bytes,
      mimeType: info.mime_type ?? file.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  async health() {
    return {
      ok: true,
      details: {
        configured: this.capabilities.send,
        groupsEnabled: this.options.groupsEnabled ?? false,
      },
    };
  }
}
