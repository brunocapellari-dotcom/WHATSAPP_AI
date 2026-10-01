import type { RawMessage } from '../domain/schemas.js';

/**
 * Persist only the technical provenance required to audit how a canonical raw
 * message entered the system. Provider payloads remain in the encrypted,
 * short-retention quarantine and are deliberately not copied into analytical
 * storage because they may contain unnecessary PII.
 */
export function minimizedSourceProvenance(message: RawMessage): Record<string, unknown> {
  return {
    provider: message.provider,
    collectorId: message.collectorId,
    accountId: message.accountId,
    providerMessageId: message.messageId,
    occurredAt: message.occurredAt.toISOString(),
    receivedAt: message.receivedAt.toISOString(),
    messageType: message.messageType,
    contentHash: message.contentHash,
    hasAttachment: Boolean(message.attachmentReference),
    isGroup: Boolean(message.groupId),
    sourcePayloadRetainedInQuarantine: Boolean(message.sourcePayload),
    schemaVersion: message.schemaVersion,
  };
}
