import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import {
  parseOfficeDocumentIsolated,
  runIsolatedWorker,
} from '../../src/security/document-parser-sandbox.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('document parser sandbox', () => {
  it('terminates a parser that exceeds its time budget', async () => {
    await expect(runIsolatedWorker(
      `setInterval(() => {}, 1000)`,
      null,
      {
        timeoutMs: 30,
        resourceLimits: {
          maxOldGenerationSizeMb: 32,
          maxYoungGenerationSizeMb: 8,
          stackSizeMb: 2,
        },
      },
    )).rejects.toThrow('document_parser_timeout');
  });

  it('extracts an XLSX in an isolated worker', async () => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ['Produto', 'Origem', 'Destino', 'Frete'],
      ['SOJA', 'Sinop/MT', 'Rondonópolis/MT', 180],
    ]);
    XLSX.utils.book_append_sheet(workbook, sheet, 'Fretes');
    const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    const text = await parseOfficeDocumentIsolated({
      bytes,
      mimeType: XLSX_MIME,
      timeoutMs: 5_000,
    });

    expect(text).toContain('# Fretes');
    expect(text).toContain('SOJA');
    expect(text).toContain('Rondonópolis/MT');
  });

  it('rejects unsupported document types before worker creation', async () => {
    await expect(parseOfficeDocumentIsolated({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'application/pdf',
    })).rejects.toThrow('unsupported_sandbox_document_type');
  });
});
