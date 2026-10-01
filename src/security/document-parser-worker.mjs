import { parentPort, workerData } from 'node:worker_threads';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_SHEETS = 20;
const MAX_SHEET_TEXT = 100_000;
const MAX_OUTPUT = 200_000;

async function main() {
  try {
    const bytes = Buffer.from(workerData.bytes);
    const mimeType = workerData.mimeType;
    let text = '';

    if (mimeType === XLSX_MIME) {
      const imported = await import('xlsx');
      const XLSX = imported.default ?? imported;
      const workbook = XLSX.read(bytes, {
        type: 'buffer',
        cellDates: true,
        cellFormula: false,
        cellHTML: false,
        dense: true,
      });

      const rows = [];
      let totalLength = 0;
      for (const sheetName of workbook.SheetNames.slice(0, MAX_SHEETS)) {
        const sheet = workbook.Sheets[sheetName];
        if (!sheet) continue;
        const header = '# ' + String(sheetName).slice(0, 200);
        const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false }).slice(0, MAX_SHEET_TEXT);
        rows.push(header, csv);
        totalLength += header.length + csv.length + 2;
        if (totalLength >= MAX_OUTPUT) break;
      }
      text = rows.join('\n').slice(0, MAX_OUTPUT);
    } else if (mimeType === DOCX_MIME) {
      const imported = await import('mammoth');
      const mammoth = imported.default ?? imported;
      const result = await mammoth.extractRawText({ buffer: bytes });
      text = String(result.value ?? '').slice(0, MAX_OUTPUT);
    } else {
      throw new Error('unsupported_sandbox_document_type');
    }

    parentPort?.postMessage({ ok: true, text });
  } catch (error) {
    parentPort?.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : 'document_parser_failed',
    });
  }
}

await main();
