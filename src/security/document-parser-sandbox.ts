import { Worker, type ResourceLimits } from 'node:worker_threads';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const DOCUMENT_PARSER_WORKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads');

(async () => {
  try {
    const bytes = Buffer.from(workerData.bytes);
    const mimeType = workerData.mimeType;
    let text = '';

    if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
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
      for (const sheetName of workbook.SheetNames.slice(0, 20)) {
        const sheet = workbook.Sheets[sheetName];
        if (!sheet) continue;
        const header = '# ' + sheetName;
        const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false }).slice(0, 100000);
        rows.push(header, csv);
        totalLength += header.length + csv.length + 2;
        if (totalLength >= 200000) break;
      }
      text = rows.join('\n').slice(0, 200000);
    } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const imported = await import('mammoth');
      const mammoth = imported.default ?? imported;
      const result = await mammoth.extractRawText({ buffer: bytes });
      text = String(result.value ?? '').slice(0, 200000);
    } else {
      throw new Error('unsupported_sandbox_document_type');
    }

    parentPort.postMessage({ ok: true, text });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : 'document_parser_failed',
    });
  }
})();
`;

type WorkerResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

export async function runIsolatedWorker<T>(
  script: string,
  workerData: unknown,
  options: {
    timeoutMs: number;
    resourceLimits?: ResourceLimits;
  },
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const worker = new Worker(script, {
      eval: true,
      workerData,
      resourceLimits: options.resourceLimits,
    });

    let timer: NodeJS.Timeout;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };

    timer = setTimeout(() => {
      finish(() => {
        void worker.terminate();
        reject(new Error('document_parser_timeout'));
      });
    }, options.timeoutMs);
    timer.unref();

    worker.once('message', (value: T) => {
      finish(() => resolve(value));
    });
    worker.once('error', (error) => {
      finish(() => reject(error));
    });
    worker.once('exit', (code) => {
      if (settled) return;
      finish(() => reject(new Error(`document_parser_worker_exit:${code}`)));
    });
  });
}

export async function parseOfficeDocumentIsolated(input: {
  bytes: Uint8Array;
  mimeType: string;
  timeoutMs?: number;
}): Promise<string> {
  if (input.mimeType !== XLSX_MIME && input.mimeType !== DOCX_MIME) {
    throw new Error('unsupported_sandbox_document_type');
  }

  const result = await runIsolatedWorker<WorkerResult>(
    DOCUMENT_PARSER_WORKER,
    {
      bytes: Buffer.from(input.bytes),
      mimeType: input.mimeType,
    },
    {
      timeoutMs: input.timeoutMs ?? 15_000,
      resourceLimits: {
        maxOldGenerationSizeMb: 96,
        maxYoungGenerationSizeMb: 32,
        stackSizeMb: 4,
      },
    },
  );

  if (!result.ok) throw new Error(`document_parser_failed:${result.error}`);
  return result.text.slice(0, 200_000);
}
