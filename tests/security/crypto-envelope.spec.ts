import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptJson,
  encryptJson,
  isEncryptionEnvelopeV2,
} from '../../src/security/crypto.js';

function legacyEncrypt(value: unknown, secret: string): Buffer {
  const key = createHash('sha256').update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

describe('encrypted JSON envelopes', () => {
  const secret = 's'.repeat(64);

  it('writes v2 envelopes and decrypts with the matching context', () => {
    const encrypted = encryptJson({ value: 123 }, secret, 'quarantine-message');
    expect(isEncryptionEnvelopeV2(encrypted)).toBe(true);
    expect(decryptJson<{ value: number }>(
      encrypted,
      secret,
      'quarantine-message',
    )).toEqual({ value: 123 });
  });

  it('cryptographically rejects cross-domain ciphertext reuse', () => {
    const encrypted = encryptJson(
      { routingAddress: 'route-secret' },
      secret,
      'conversation-routing',
    );
    expect(() => decryptJson(
      encrypted,
      secret,
      'quarantine-message',
    )).toThrow();
  });

  it('detects ciphertext or authentication-tag tampering', () => {
    const encrypted = Buffer.from(
      encryptJson({ value: 'sensitive' }, secret, 'approval-input'),
    );
    encrypted[encrypted.length - 1] ^= 0xff;
    expect(() => decryptJson(encrypted, secret, 'approval-input')).toThrow();
  });

  it('keeps legacy v1 records readable during migration', () => {
    const encrypted = legacyEncrypt({ legacy: true }, secret);
    expect(isEncryptionEnvelopeV2(encrypted)).toBe(false);
    expect(decryptJson<{ legacy: boolean }>(
      encrypted,
      secret,
      'business-run-result',
    )).toEqual({ legacy: true });
  });

  it('rejects invalid encryption contexts', () => {
    expect(() => encryptJson({ value: 1 }, secret, 'x')).toThrow(
      'invalid_encryption_context',
    );
  });
});
