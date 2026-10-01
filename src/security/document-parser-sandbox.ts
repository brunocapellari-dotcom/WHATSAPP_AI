import { Worker, type ResourceLimits } from 'node:worker_threads';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOCUMENT_PARSER_WORKER_URL = new URL('./document-parser-worker.mjs', import.meta.url);

type WorkerResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

export async function runIsolatedWorker<T>(
  workerUrl: URL,
  workerData: unknown,
  options: {
    timeoutMs: number;
    resourceLimits?: ResourceLimits;
  },
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const worker = new Worker(workerUrl, {
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
    DOCUMENT_PARSER_WORKER_URL,
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
