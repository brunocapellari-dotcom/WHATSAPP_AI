import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { inspectOfficeArchive } from '../../src/security/archive-inspection.js';
import { validateAttachment } from '../../src/security/attachments.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const cleanScanner = { async scan() { return { clean: true }; } };

function workbookBytes() {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ['Produto', 'Origem', 'Destino'],
      ['SOJA', 'Sinop/MT', 'Rondonópolis/MT'],
    ]),
    'Fretes',
  );
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

describe('Office archive inspection', () => {
  it('accepts a structurally valid XLSX within expansion limits', async () => {
    const bytes = workbookBytes();
    const inspected = await inspectOfficeArchive({ bytes, mimeType: XLSX_MIME });
    expect(inspected.entries).toBeGreaterThan(1);
    expect(inspected.totalUncompressedBytes).toBeGreaterThan(0);

    const validated = await validateAttachment({
      bytes,
      declaredMime: XLSX_MIME,
      maxBytes: 2_000_000,
      scanner: cleanScanner,
    });
    expect(validated.accepted).toBe(true);
  });

  it('rejects the same XLSX when declared uncompressed content exceeds policy', async () => {
    const bytes = workbookBytes();
    await expect(inspectOfficeArchive({
      bytes,
      mimeType: XLSX_MIME,
      limits: { maxTotalUncompressedBytes: 100 },
    })).rejects.toThrow('office_archive_expansion_too_large');
  });

  it('rejects a ZIP that does not contain the expected Office structure', async () => {
    await expect(inspectOfficeArchive({
      bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      mimeType: XLSX_MIME,
    })).rejects.toThrow();
  });
});
