import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import rawBody from 'fastify-raw-body';
import type { AppConfig } from '../config.js';
import type { CollectorResolver, WhatsAppProvider } from '../domain/ports.js';
import type { Pool } from 'pg';
import type { ClamAvScanner } from '../infra/clamav.js';
import type { IngestionService } from '../app/ingestion-service.js';
import type { Metrics } from '../observability/metrics.js';
import { constantTimeEquals, hmacSha256 } from '../security/crypto.js';
import { verifyMetaSignature, verifyWebhookChallenge } from '../security/webhook.js';
import { internalApiAuth } from './auth.js';

export async function buildHttpApp(input: {
  config: AppConfig;
  ingestion: IngestionService;
  collectors: CollectorResolver;
  providers: Map<string, WhatsAppProvider>;
  metrics: Metrics;
  pool: Pool;
  clamav?: ClamAvScanner;
}) {
  const app = Fastify({ logger: { level: input.config.NODE_ENV === 'test' ? 'silent' : 'info' }, bodyLimit: input.config.ATTACHMENT_MAX_BYTES });
  await app.register(helmet, { global: true });
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });
  await app.register(rawBody, { field: 'rawBody', global: false, encoding: false, runFirst: true });

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    const providerChecks = await Promise.all([...input.providers.values()].map(async (p) => ({ component: `provider:${p.id}`, ...(await p.health()) })));
    let databaseOk = false;
    try { await input.pool.query('SELECT 1'); databaseOk = true; } catch { databaseOk = false; }
    const checks: Array<{ component: string; ok: boolean; detail?: string }> = [
      { component: 'database', ok: databaseOk },
      ...providerChecks.map((x) => ({ component: x.component, ok: x.ok, ...(x.detail ? { detail: x.detail } : {}) })),
    ];
    if (input.clamav) checks.push({ component: 'clamav', ok: await input.clamav.ping() });
    const requiredOk = checks.every((x) => x.ok);
    return reply.code(requiredOk ? 200 : 503).send({ status: requiredOk ? 'ok' : 'degraded', checks });
  });
  const metricsRoute = input.config.METRICS_TOKEN ? { preHandler: internalApiAuth(input.config.METRICS_TOKEN) } : {};
  app.get('/metrics', metricsRoute, async (_request, reply) =>
    reply.type(input.metrics.registry.contentType).send(await input.metrics.registry.metrics()),
  );

  app.get('/webhooks/meta', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;
    const challenge = verifyWebhookChallenge({ mode: q['hub.mode'], verifyToken: q['hub.verify_token'], challenge: q['hub.challenge'], expectedVerifyToken: input.config.META_VERIFY_TOKEN });
    if (challenge == null) return reply.code(403).send('forbidden');
    return reply.type('text/plain').send(challenge);
  });

  app.post('/webhooks/meta/:collectorId', { config: { rawBody: true } }, async (request, reply) => {
    const raw = (request as typeof request & { rawBody?: Buffer }).rawBody;
    if (!raw || !verifyMetaSignature(raw, request.headers['x-hub-signature-256'] as string | undefined, input.config.META_APP_SECRET)) {
      return reply.code(401).send({ error: 'invalid_signature' });
    }
    const collectorId = (request.params as { collectorId: string }).collectorId;
    try {
      const rows = await input.ingestion.ingest('meta-cloud', collectorId, request.body);
      for (const row of rows) input.metrics.messages.inc({ provider: 'meta-cloud', disposition: row.disposition });
      return reply.code(200).send({ accepted: rows.length });
    } catch (error) {
      input.metrics.failures.inc({ component: 'meta-webhook' });
      request.log.error(error);
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'ingestion_error' });
    }
  });

  app.post('/webhooks/wppconnect/:collectorId', { config: { rawBody: true } }, async (request, reply) => {
    if (!input.config.WPP_WEBHOOK_SECRET) return reply.code(503).send({ error: 'wpp_webhook_disabled' });
    const raw = (request as typeof request & { rawBody?: Buffer }).rawBody;
    const supplied = request.headers['x-provider-signature'];
    const expected = raw ? `sha256=${hmacSha256(raw, input.config.WPP_WEBHOOK_SECRET)}` : '';
    if (!raw || typeof supplied !== 'string' || !constantTimeEquals(supplied, expected)) return reply.code(401).send({ error: 'invalid_signature' });
    const collectorId = (request.params as { collectorId: string }).collectorId;
    const rows = await input.ingestion.ingest('wppconnect', collectorId, request.body);
    for (const row of rows) input.metrics.messages.inc({ provider: 'wppconnect', disposition: row.disposition });
    return reply.code(200).send({ accepted: rows.length });
  });

  app.get('/v1/providers', { preHandler: internalApiAuth(input.config.INTERNAL_API_KEY) }, async () =>
    [...input.providers.values()].map((p) => ({ id: p.id, capabilities: p.capabilities })),
  );

  return app;
}
