import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yauzl = require('yauzl') as {
  fromBuffer(
    buffer: Buffer,
    options: { lazyEntries: boolean; validateEntrySizes: boolean; autoClose: boolean },
    callback: (error: Error | null, zipFile?: {
      readEntry(): void;
      close(): void;
      on(event: 'entry', listener: (entry: {
        fileName: string;
        compressedSize: number;
        uncompressedSize: number;
        isEncrypted(): boolean;
      }) => void): void;
      on(event: 'end', listener: () => void): void;
      on(event: 'error', listener: (error: Error) => void): void;
    }) => void,
  ): void;
};

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export type ArchiveInspectionLimits = {
  maxEntries: number;
  maxTotalUncompressedBytes: number;
  maxEntryUncompressedBytes: number;
};

const DEFAULT_LIMITS: ArchiveInspectionLimits = {
  maxEntries: 5_000,
  maxTotalUncompressedBytes: 256 * 1024 * 1024,
  maxEntryUncompressedBytes: 128 * 1024 * 1024,
};

export async function inspectOfficeArchive(input: {
  bytes: Uint8Array;
  mimeType: string;
  limits?: Partial<ArchiveInspectionLimits>;
}): Promise<{
  entries: number;
  totalUncompressedBytes: number;
}> {
  if (input.mimeType !== XLSX_MIME && input.mimeType !== DOCX_MIME) {
    throw new Error('unsupported_office_archive_type');
  }

  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  const expectedEntry = input.mimeType === XLSX_MIME
    ? 'xl/workbook.xml'
    : 'word/document.xml';

  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      Buffer.from(input.bytes),
      { lazyEntries: true, validateEntrySizes: true, autoClose: true },
      (openError, zipFile) => {
        if (openError || !zipFile) {
          reject(new Error(`office_archive_open_failed:${openError?.message ?? 'unknown'}`));
          return;
        }

        let settled = false;
        let entries = 0;
        let totalUncompressedBytes = 0;
        let expectedEntryFound = false;

        const fail = (reason: string) => {
          if (settled) return;
          settled = true;
          try { zipFile.close(); } catch {}
          reject(new Error(reason));
        };

        zipFile.on('error', (error) => {
          fail(`office_archive_invalid:${error.message}`);
        });

        zipFile.on('entry', (entry) => {
          if (settled) return;
          entries++;

          if (entries > limits.maxEntries) {
            fail('office_archive_too_many_entries');
            return;
          }
          if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
            fail('office_archive_invalid_entry_size');
            return;
          }
          if (entry.uncompressedSize > limits.maxEntryUncompressedBytes) {
            fail('office_archive_entry_too_large');
            return;
          }
          totalUncompressedBytes += entry.uncompressedSize;
          if (
            !Number.isSafeInteger(totalUncompressedBytes)
            || totalUncompressedBytes > limits.maxTotalUncompressedBytes
          ) {
            fail('office_archive_expansion_too_large');
            return;
          }
          if (entry.isEncrypted()) {
            fail('office_archive_encrypted');
            return;
          }

          const normalizedName = entry.fileName.replaceAll('\\', '/');
          if (normalizedName === expectedEntry) expectedEntryFound = true;
          zipFile.readEntry();
        });

        zipFile.on('end', () => {
          if (settled) return;
          if (!expectedEntryFound) {
            fail('office_archive_structure_mismatch');
            return;
          }
          settled = true;
          resolve({ entries, totalUncompressedBytes });
        });

        zipFile.readEntry();
      },
    );
  });
}
