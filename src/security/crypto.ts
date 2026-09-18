import { createCipheriv,createDecipheriv,createHash,createHmac,randomBytes,timingSafeEqual } from 'node:crypto';

export function sha256(value:string|Uint8Array):string{
  return createHash('sha256').update(value).digest('hex');
}

export function hmacSha256(value:string|Uint8Array,secret:string):string{
  return createHmac('sha256',secret).update(value).digest('hex');
}

export function pseudonymize(value:string,secret:string):string{
  return `hmac:${hmacSha256(value,secret)}`;
}

export function deterministicUuid(value:string):string{
  const hex=sha256(value).slice(0,32).split('');
  hex[12]='5';
  hex[16]=((Number.parseInt(hex[16]??'0',16)&0x3)|0x8).toString(16);
  const joined=hex.join('');
  return `${joined.slice(0,8)}-${joined.slice(8,12)}-${joined.slice(12,16)}-${joined.slice(16,20)}-${joined.slice(20,32)}`;
}

export function constantTimeEquals(a:string,b:string):boolean{
  const aa=Buffer.from(a);
  const bb=Buffer.from(b);
  return aa.length===bb.length&&timingSafeEqual(aa,bb);
}

function encryptionKey(secret:string):Buffer{
  return createHash('sha256').update(secret).digest();
}

export function encryptJson(value:unknown,secret:string):Buffer{
  const iv=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',encryptionKey(secret),iv);
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
  const tag=cipher.getAuthTag();
  return Buffer.concat([iv,tag,ciphertext]);
}

export function decryptJson<T>(payload:Uint8Array,secret:string):T{
  const buffer=Buffer.from(payload);
  if(buffer.length<28)throw new Error('invalid_encrypted_payload');
  const iv=buffer.subarray(0,12);
  const tag=buffer.subarray(12,28);
  const ciphertext=buffer.subarray(28);
  const decipher=createDecipheriv('aes-256-gcm',encryptionKey(secret),iv);
  decipher.setAuthTag(tag);
  const plaintext=Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString('utf8');
  return JSON.parse(plaintext) as T;
}
