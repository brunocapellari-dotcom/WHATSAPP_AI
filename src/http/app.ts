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

function ingestionHttpStatus(error: unknown): number {
  const code = error instanceof Error ? error.message : '';
  if (code === 'collector_not_found') return 404;
  if (code === 'collector_disabled') return 403;
  if (code === 'provider_not_configured') return 503;
  return 500;
}

function ingestionPublicError(status: number): string {
  if (status === 404) return 'collector_not_found';
  if (status === 403) return 'collector_disabled';
  if (status === 503) return 'service_unavailable';
  return 'ingestion_error';
}

export async function buildHttpApp(input: {
  config: AppConfig;
  ingestion: IngestionService;
  collectors: CollectorResolver;
  providers: Map<string, WhatsAppProvider>;
  metrics: Metrics;
  pool: Pool;
  clamav?: ClamAvScanner;
}) {
  const app = Fastify({
    logger: { level: input.config.NODE_ENV === 'test' ? 'silent' : 'info' },
    bodyLimit: input.config.ATTACHMENT_MAX_BYTES,
  });

  await app.register(helmet, { global: true });
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });
  await app.register(rawBody, {
    field: 'rawBody',
    global: false,
    encoding: false,
    runFirst: true,
  });

  app.get('/health/live', async () => ({ status: 'ok' }));

  app.get('/health/ready', async (_request, reply) => {
    const providerChecks = await Promise.all(
      [...input.providers.values()].map(async (provider) => ({
        component: `provider:${provider.id}`,
        ...(await provider.health()),
      })),
    );

    let databaseOk = false;
    try {
      await input.pool.query('SELECT 1');
      databaseOk = true;
    } catch {
      databaseOk = false;
    }

    const checks: Array<{ component: string; ok: boolean; detail?: string }> = [
      { component: 'database', ok: databaseOk },
      ...providerChecks.map((x) => ({
        component: x.component,
        ok: x.ok,
        ...(x.detail ? { detail: x.detail } : {}),
      })),
    ];

    if (input.clamav) checks.push({ component: 'clamav', ok: await input.clamav.ping() });
    const requiredOk = checks.every((x) => x.ok);
    return reply.code(requiredOk ? 200 : 503).send({
      status: requiredOk ? 'ok' : 'degraded',
      checks,
    });
  });

  const metricsRoute = input.config.METRICS_TOKEN
    ? { preHandler: internalApiAuth(input.config.METRICS_TOKEN) }
    : {};

  app.get('/metrics', metricsRoute, async (_request, reply) =>
    reply.type(input.metrics.registry.contentType).send(await input.metrics.registry.metrics()),
  );

  app.get('/webhooks/meta', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;
    const challenge = verifyWebhookChallenge({
      mode: q['hub.mode'],
      verifyToken: q['hub.verify_token'],
      challenge: q['hub.challenge'],
      expectedVerifyToken: input.config.META_VERIFY_TOKEN,
    });
    if (challenge == null) return reply.code(403).send('forbidden');
    return reply.type('text/plain').send(challenge);
  });

  app.post('/webhooks/meta/:collectorId', { config: { rawBody: true } }, async (request, reply) => {
    const raw = (request as typeof request & { rawBody?: Buffer }).rawBody;
    if (
      !raw ||
      !verifyMetaSignature(
        raw,
        request.headers['x-hub-signature-256'] as string | undefined,
        input.config.META_APP_SECRET,
      )
    ) {
      return reply.code(401).send({ error: 'invalid_signature' });
    }

    const collectorId = (request.params as { collectorId: string }).collectorId;
    try {
      const rows = await input.ingestion.ingest('meta-cloud', collectorId, request.body);
      for (const row of rows) {
        input.metrics.messages.inc({ provider: 'meta-cloud', disposition: row.disposition });
      }
      input.metrics.collectorHealth.set({ collector: collectorId, provider: 'meta-cloud' }, 1);
      return reply.code(200).send({ accepted: rows.length });
    } catch (error) {
      const status = ingestionHttpStatus(error);
      input.metrics.failures.inc({ component: 'meta-webhook' });
      input.metrics.collectorHealth.set({ collector: collectorId, provider: 'meta-cloud' }, 0);
      request.log.error({ err: error, collectorId, requestId: request.id }, 'meta webhook ingestion failed');
      return reply.code(status).send({
        error: ingestionPublicError(status),
        requestId: request.id,
      });
    }
  });

  app.post('/webhooks/wppconnect/:collectorId', { config: { rawBody: true } }, async (request, reply) => {
    if (!input.config.WPP_WEBHOOK_SECRET) {
      return reply.code(503).send({ error: 'wpp_webhook_disabled' });
    }

    const raw = (request as typeof request & { rawBody?: Buffer }).rawBody;
    const supplied = request.headers['x-provider-signature'];
    const expected = raw ? `sha256=${hmacSha256(raw, input.config.WPP_WEBHOOK_SECRET)}` : '';

    if (!raw || typeof supplied !== 'string' || !constantTimeEquals(supplied, expected)) {
      return reply.code(401).send({ error: 'invalid_signature' });
    }

    const collectorId = (request.params as { collectorId: string }).collectorId;
    try {
      const rows = await input.ingestion.ingest('wppconnect', collectorId, request.body);
      for (const row of rows) {
        input.metrics.messages.inc({ provider: 'wppconnect', disposition: row.disposition });
      }
      input.metrics.collectorHealth.set({ collector: collectorId, provider: 'wppconnect' }, 1);
      return reply.code(200).send({ accepted: rows.length });
    } catch (error) {
      const status = ingestionHttpStatus(error);
      input.metrics.failures.inc({ component: 'wppconnect-webhook' });
      input.metrics.collectorHealth.set({ collector: collectorId, provider: 'wppconnect' }, 0);
      request.log.error({ err: error, collectorId, requestId: request.id }, 'WPPConnect webhook ingestion failed');
      return reply.code(status).send({
        error: ingestionPublicError(status),
        requestId: request.id,
      });
    }
  });

  app.get(
    '/v1/providers',
    { preHandler: internalApiAuth(input.config.INTERNAL_API_KEY) },
    async () => [...input.providers.values()].map((provider) => ({
      id: provider.id,
      capabilities: provider.capabilities,
    })),
  );

  return app;
}
