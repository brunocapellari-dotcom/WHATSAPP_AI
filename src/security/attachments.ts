import { fileTypeFromBuffer } from 'file-type';
import type { MalwareScanner } from '../domain/ports.js';
import { inspectOfficeArchive } from './archive-inspection.js';

const TEXT_MIMES = new Set(['text/plain', 'text/csv']);
const OFFICE_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const ALLOWED = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'text/plain',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

export type AttachmentValidation = {
  accepted: boolean;
  reason: string;
  detectedMime?: string;
};

function normalizeMime(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

export async function validateAttachment(input: {
  bytes: Uint8Array;
  declaredMime: string;
  maxBytes: number;
  scanner: MalwareScanner;
}): Promise<AttachmentValidation> {
  if (input.bytes.byteLength === 0) return { accepted: false, reason: 'empty_file' };
  if (input.bytes.byteLength > input.maxBytes) return { accepted: false, reason: 'file_too_large' };

  const declaredMime = normalizeMime(input.declaredMime);
  if (!ALLOWED.has(declaredMime)) return { accepted: false, reason: 'mime_not_allowed' };

  let detectedMime: string | undefined;
  try {
    detectedMime = (await fileTypeFromBuffer(input.bytes))?.mime;
  } catch {
    return { accepted: false, reason: 'mime_detection_failed' };
  }

  if (TEXT_MIMES.has(declaredMime)) {
    if (detectedMime) {
      return { accepted: false, reason: 'text_contains_binary_signature', detectedMime };
    }
    detectedMime = declaredMime;
  } else {
    if (!detectedMime) return { accepted: false, reason: 'mime_unrecognized' };
    if (detectedMime !== declaredMime) {
      return { accepted: false, reason: 'mime_magic_mismatch', detectedMime };
    }
  }

  if (OFFICE_MIMES.has(detectedMime)) {
    try {
      await inspectOfficeArchive({
        bytes: input.bytes,
        mimeType: detectedMime,
      });
    } catch (error) {
      return {
        accepted: false,
        reason: error instanceof Error ? error.message : 'office_archive_invalid',
        detectedMime,
      };
    }
  }

  const scan = await input.scanner.scan(input.bytes);
  if (!scan.clean) {
    return { accepted: false, reason: `malware:${scan.signature ?? 'detected'}`, detectedMime };
  }

  return { accepted: true, reason: 'accepted', detectedMime };
}
