import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const ENVELOPE_V2_MAGIC = Buffer.from('WAI2', 'ascii');
const ENVELOPE_V2_SALT = Buffer.from('whatsapp-ai-envelope-v2', 'utf8');

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hmacSha256(value: string | Uint8Array, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function pseudonymize(value: string, secret: string): string {
  return `hmac:${hmacSha256(value, secret)}`;
}

export function deterministicUuid(value: string): string {
  const hex = sha256(value).slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const joined = hex.join('');
  return `${joined.slice(0,8)}-${joined.slice(8,12)}-${joined.slice(12,16)}-${joined.slice(16,20)}-${joined.slice(20,32)}`;
}

export function constantTimeEquals(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function validateEncryptionContext(context: string): string {
  const normalized = context.trim();
  if (!/^[a-z0-9][a-z0-9:._-]{2,99}$/i.test(normalized)) {
    throw new Error('invalid_encryption_context');
  }
  return normalized;
}

function legacyEncryptionKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

function encryptionKey(secret: string, context: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(secret, 'utf8'),
      ENVELOPE_V2_SALT,
      Buffer.from(`context:${context}`, 'utf8'),
      32,
    ),
  );
}

function encryptionAad(context: string): Buffer {
  return Buffer.from(`whatsapp-ai:v2:${context}`, 'utf8');
}

export function encryptJson(value: unknown, secret: string, context: string): Buffer {
  const domain = validateEncryptionContext(context);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret, domain), iv);
  cipher.setAAD(encryptionAad(domain));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([ENVELOPE_V2_MAGIC, iv, tag, ciphertext]);
}

export function decryptJson<T>(
  payload: Uint8Array,
  secret: string,
  context: string,
): T {
  const buffer = Buffer.from(payload);

  if (buffer.subarray(0, ENVELOPE_V2_MAGIC.length).equals(ENVELOPE_V2_MAGIC)) {
    const domain = validateEncryptionContext(context);
    if (buffer.length < ENVELOPE_V2_MAGIC.length + 28) {
      throw new Error('invalid_encrypted_payload');
    }
    const offset = ENVELOPE_V2_MAGIC.length;
    const iv = buffer.subarray(offset, offset + 12);
    const tag = buffer.subarray(offset + 12, offset + 28);
    const ciphertext = buffer.subarray(offset + 28);
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(secret, domain), iv);
    decipher.setAAD(encryptionAad(domain));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plaintext) as T;
  }

  // Legacy v1 compatibility. Existing records are readable during the
  // transition, but every new write uses the context-separated v2 envelope.
  if (buffer.length < 28) throw new Error('invalid_encrypted_payload');
  const iv = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const ciphertext = buffer.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', legacyEncryptionKey(secret), iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(plaintext) as T;
}

export function isEncryptionEnvelopeV2(payload: Uint8Array): boolean {
  const buffer = Buffer.from(payload);
  return buffer.length >= ENVELOPE_V2_MAGIC.length
    && buffer.subarray(0, ENVELOPE_V2_MAGIC.length).equals(ENVELOPE_V2_MAGIC);
}
