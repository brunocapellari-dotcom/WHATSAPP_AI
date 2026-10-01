import { buildDocumentParserApp } from './security/document-parser-http.js';

const port = Number(process.env.DOCUMENT_PARSER_PORT ?? 8090);
const maxBytes = Number(process.env.DOCUMENT_PARSER_MAX_BYTES ?? 25 * 1024 * 1024);
const timeoutMs = Number(process.env.DOCUMENT_PARSER_TIMEOUT_MS ?? 15_000);

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_document_parser_port');
if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024) throw new Error('invalid_document_parser_max_bytes');
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) throw new Error('invalid_document_parser_timeout');

const app = await buildDocumentParserApp({ maxBytes, timeoutMs });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'document parser shutting down');
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: '0.0.0.0', port });
