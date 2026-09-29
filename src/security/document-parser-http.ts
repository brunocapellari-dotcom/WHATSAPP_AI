import Fastify from 'fastify';
import { parseOfficeDocumentIsolated } from './document-parser-sandbox.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const ALLOWED_MIMES = new Set([XLSX_MIME, DOCX_MIME]);

export async function buildDocumentParserApp(options: {
  maxBytes: number;
  timeoutMs: number;
}) {
  const app = Fastify({
    logger: true,
    bodyLimit: options.maxBytes,
  });

  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/parse', async (request, reply) => {
    const mimeHeader = request.headers['x-document-mime'];
    const mimeType = typeof mimeHeader === 'string' ? mimeHeader.trim().toLowerCase() : '';
    if (!ALLOWED_MIMES.has(mimeType)) {
      return reply.code(415).send({ error: 'unsupported_document_type' });
    }

    const bytes = request.body;
    if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0) {
      return reply.code(400).send({ error: 'empty_document' });
    }
    if (bytes.byteLength > options.maxBytes) {
      return reply.code(413).send({ error: 'document_too_large' });
    }

    try {
      const text = await parseOfficeDocumentIsolated({
        bytes,
        mimeType,
        timeoutMs: options.timeoutMs,
      });
      return { text };
    } catch (error) {
      request.log.warn({
        error: error instanceof Error ? error.message : 'document_parser_failed',
      }, 'document parser rejected input');
      return reply.code(422).send({ error: 'document_parse_failed' });
    }
  });

  return app;
}
