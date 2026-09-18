import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import rawBody from 'fastify-raw-body';
import type { AppConfig } from '../config.js';
import type { CollectorResolver, WhatsAppProvider } from '../domain/ports.js';
import type { Pool } from 'pg';
import type { ClamAvScanner } from '../infra/clamav.js';
import type { WebhookInbox } from '../infra/webhook-inbox.js';
import type { Metrics } from '../observability/metrics.js';
import { constantTimeEquals, hmacSha256 } from '../security/crypto.js';
import { verifyMetaSignature, verifyWebhookChallenge } from '../security/webhook.js';
import { internalApiAuth } from './auth.js';

type QueueInboundResult = { status: number; outcome: 'queued' | 'duplicate' | 'rejected'; body: Record<string, unknown> };

async function queueInboundWebhook(input: {
  providerId: string;
  collectorId: string;
  rawBody: Buffer;
  collectors: CollectorResolver;
  inbox: WebhookInbox;
}): Promise<QueueInboundResult> {
  const collector = await input.collectors.resolve(input.collectorId);
  if (!collector || collector.provider !== input.providerId) {
    return { status: 404, outcome: 'rejected', body: { error: 'collector_not_found' } };
  }
  if (collector.status === 'DISABLED') {
    return { status: 403, outcome: 'rejected', body: { error: 'collector_disabled' } };
  }

  const accepted = await input.inbox.accept({
    tenantId: collector.tenantId,
    provider: input.providerId,
    collectorId: input.collectorId,
    rawBody: input.rawBody,
  });

  return {
    status: 200,
    outcome: accepted.inserted ? 'queued' : 'duplicate',
    body: {
      accepted: true,
      queued: accepted.inserted,
      ingressId: accepted.ingressId,
    },
  };
}

export async function buildHttpApp(input: {
  config: AppConfig;
  collectors: CollectorResolver;
  providers: Map<string, WhatsAppProvider>;
  webhookInbox: WebhookInbox;
  metrics: Metrics;
  pool: Pool;
  clamav?: ClamAvScanner;
}) {
  const app = Fastify({
    logger: { level: input.config.NODE_ENV === 'test' ? 'silent' : 'info' },
    bodyLimit: input.config.WEBHOOK_MAX_BYTES,
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
      const queued = await queueInboundWebhook({
        providerId: 'meta-cloud',
        collectorId,
        rawBody: raw,
        collectors: input.collectors,
        inbox: input.webhookInbox,
      });
      input.metrics.webhookIngress.inc({
        provider: 'meta-cloud',
        outcome: queued.outcome,
      });
      return reply.code(queued.status).send(queued.body);
    } catch (error) {
      input.metrics.failures.inc({ component: 'meta-webhook-inbox' });
      input.metrics.webhookIngress.inc({ provider: 'meta-cloud', outcome: 'error' });
      request.log.error({ err: error, collectorId, requestId: request.id }, 'meta webhook durable acceptance failed');
      return reply.code(503).send({ error: 'ingress_unavailable', requestId: request.id });
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
      const queued = await queueInboundWebhook({
        providerId: 'wppconnect',
        collectorId,
        rawBody: raw,
        collectors: input.collectors,
        inbox: input.webhookInbox,
      });
      input.metrics.webhookIngress.inc({
        provider: 'wppconnect',
        outcome: queued.outcome,
      });
      return reply.code(queued.status).send(queued.body);
    } catch (error) {
      input.metrics.failures.inc({ component: 'wppconnect-webhook-inbox' });
      input.metrics.webhookIngress.inc({ provider: 'wppconnect', outcome: 'error' });
      request.log.error({ err: error, collectorId, requestId: request.id }, 'WPPConnect webhook durable acceptance failed');
      return reply.code(503).send({ error: 'ingress_unavailable', requestId: request.id });
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
