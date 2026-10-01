import { readResponseBytesLimited } from './download.js';

export class DocumentParserClient {
  constructor(private readonly options: {
    baseUrl: string;
    timeoutMs: number;
    maxBytes: number;
  }) {}

  async parse(input: { bytes: Uint8Array; mimeType: string }): Promise<string> {
    if (input.bytes.byteLength === 0) throw new Error('empty_document');
    if (input.bytes.byteLength > this.options.maxBytes) throw new Error('document_too_large');

    const response = await fetch(
      `${this.options.baseUrl.replace(/\/$/, '')}/parse`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Document-Mime': input.mimeType,
        },
        body: Buffer.from(input.bytes),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      },
    );

    if (!response.ok) {
      throw new Error(`document_parser_http_${response.status}`);
    }

    const raw = await readResponseBytesLimited(response, 512 * 1024);
    const body = JSON.parse(new TextDecoder().decode(raw)) as { text?: unknown };
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text) throw new Error('document_parser_empty_response');
    return text.slice(0, 200_000);
  }

  async health(): Promise<{ ok: boolean; status?: number; error?: string }> {
    try {
      const response = await fetch(
        `${this.options.baseUrl.replace(/\/$/, '')}/health`,
        { signal: AbortSignal.timeout(Math.min(this.options.timeoutMs, 5_000)) },
      );
      return { ok: response.ok, status: response.status };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'document_parser_unavailable',
      };
    }
  }
}
