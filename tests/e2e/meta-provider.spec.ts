import { describe, expect, it } from 'vitest';
import { MetaCloudProvider } from '../../src/providers/meta-cloud-provider.js';

describe('Meta Cloud provider normalization', () => {
  it('normalizes inbound webhook with provenance and pseudonymized sender', async () => {
    const provider = new MetaCloudProvider({ piiHmacKey: 'x'.repeat(32), graphVersion: 'v26.0' });
    const rows = await provider.normalizeInbound({
      entry: [{
        id: 'waba',
        changes: [{
          value: {
            metadata: { phone_number_id: '123' },
            messages: [{
              id: 'wamid.1',
              from: '5565999999999',
              timestamp: '1789491600',
              type: 'text',
              text: { body: 'SOJA Frete R$ 180' },
            }],
          },
        }],
      }],
    }, { tenantId: 't', collectorId: 'c' });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider).toBe('meta-cloud');
    expect(rows[0]?.senderReference.startsWith('hmac:')).toBe(true);
    expect(rows[0]?.text).toContain('SOJA');
    expect(provider.capabilities.existingGroups).toBe(false);
  });

  it('creates the same synthetic id when an id-less webhook is replayed', async () => {
    const provider = new MetaCloudProvider({ piiHmacKey: 'x'.repeat(32), graphVersion: 'v26.0' });
    const payload = {
      entry: [{
        id: 'waba',
        changes: [{
          value: {
            metadata: { phone_number_id: '123' },
            messages: [{
              from: '5565999999999',
              timestamp: '1789491600',
              type: 'text',
              text: { body: 'MILHO Frete R$ 170' },
            }],
          },
        }],
      }],
    };

    const first = await provider.normalizeInbound(payload, { tenantId: 't', collectorId: 'c' });
    const replay = await provider.normalizeInbound(payload, { tenantId: 't', collectorId: 'c' });

    expect(first[0]?.messageId.startsWith('synthetic:')).toBe(true);
    expect(first[0]?.messageId).toBe(replay[0]?.messageId);
  });
});
