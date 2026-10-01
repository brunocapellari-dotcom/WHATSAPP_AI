import Fastify from 'fastify';
import { z } from 'zod';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import rawBody from 'fastify-raw-body';
import type { AppConfig } from '../config.js';
import type { CollectorResolver, WhatsAppProvider } from '../domain/ports.js';
import type { Pool } from 'pg';
import type { ClamAvScanner } from '../infra/clamav.js';
import type { WebhookInbox } from '../infra/webhook-inbox.js';
import type { Metrics } from '../observability/metrics.js';
import type { LocalAiClient } from '../infra/local-ai-client.js';
import type { LocalMediaProcessor } from '../infra/local-media-processor.js';
import type { OperatorService } from '../business/operator-service.js';
import type { ApprovalService } from '../business/approval-service.js';
import type { OperatorOutboundService } from '../business/operator-outbound-service.js';
import type { OperatorAuthService } from '../business/operator-auth-service.js';
import { constantTimeEquals, hmacSha256 } from '../security/crypto.js';
import { verifyMetaSignature, verifyWebhookChallenge } from '../security/webhook.js';
import { internalApiAuth, operatorApiAuth, requireOperatorIdentity } from './auth.js';

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
  localAi?: LocalAiClient;
  mediaProcessor?: LocalMediaProcessor;
  operatorService?: OperatorService;
  operatorAuthService: OperatorAuthService;
  operatorOutboundService?: OperatorOutboundService;
  approvalService?: ApprovalService;
}) {
  const app = Fastify({
    logger: {
      level: input.config.NODE_ENV === 'test' ? 'silent' : 'info',
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-provider-signature"]',
          'req.headers["x-hub-signature-256"]',
        ],
        censor: '[REDACTED]',
      },
    },
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
    if (input.localAi) {
      const localAi = await input.localAi.health();
      checks.push({
        component: 'local-ai',
        ok: localAi.ok,
        detail: JSON.stringify(localAi.details ?? {}),
      });
    }
    if (input.mediaProcessor) {
      const media = await input.mediaProcessor.health();
      checks.push({
        component: 'local-media',
        ok: media.ok,
        detail: JSON.stringify(media.details ?? {}),
      });
    }
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
    if (!input.config.META_VERIFY_TOKEN) {
      return reply.code(503).send('meta_webhook_disabled');
    }
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
    if (!input.config.META_APP_SECRET) {
      return reply.code(503).send({ error: 'meta_webhook_disabled' });
    }
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

  const tenantIdSchema = z.string().min(1).max(128);
  const conversationIdSchema = z.string().uuid();
  const operatorReferenceSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9._:@-]+$/);
  const operatorRoleSchema = z.enum(['OPERATOR','SUPERVISOR','ADMIN']);

  const operatorRoute = {
    preHandler: operatorApiAuth(input.operatorAuthService),
  };
  const supervisorRoute = {
    preHandler: operatorApiAuth(input.operatorAuthService, ['SUPERVISOR','ADMIN']),
  };
  const operatorListQuerySchema = z.object({
    state: z.enum(['OPEN','WAITING_HUMAN','HUMAN','CLOSED']).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  });
  const operatorDetailQuerySchema = z.object({
    messageLimit: z.coerce.number().int().min(1).max(200).optional(),
  });

  app.get('/v1/operator/conversations', operatorRoute, async (request, reply) => {
    if (!input.operatorService) return reply.code(503).send({ error: 'operator_service_unavailable' });
    const identity = requireOperatorIdentity(request);
    const parsed = operatorListQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    return input.operatorService.list({
      tenantId: identity.tenantId,
      ...parsed.data,
    });
  });

  app.get('/v1/operator/conversations/:conversationId', operatorRoute, async (request, reply) => {
    if (!input.operatorService) return reply.code(503).send({ error: 'operator_service_unavailable' });
    const identity = requireOperatorIdentity(request);
    const params = z.object({ conversationId: conversationIdSchema }).safeParse(request.params);
    const query = operatorDetailQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: 'invalid_request' });
    const detail = await input.operatorService.detail({
      tenantId: identity.tenantId,
      conversationId: params.data.conversationId,
      messageLimit: query.data.messageLimit,
    });
    if (!detail) return reply.code(404).send({ error: 'conversation_not_found' });
    return detail;
  });

  app.post('/v1/operator/conversations/:conversationId/claim', operatorRoute, async (request, reply) => {
    if (!input.operatorService) return reply.code(503).send({ error: 'operator_service_unavailable' });
    const identity = requireOperatorIdentity(request);
    const params = z.object({ conversationId: conversationIdSchema }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      return await input.operatorService.claim({
        tenantId: identity.tenantId,
        operatorReference: identity.operatorReference,
        conversationId: params.data.conversationId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'operator_action_failed';
      if (message === 'conversation_not_found') return reply.code(404).send({ error: message });
      if (message === 'conversation_claim_conflict') return reply.code(409).send({ error: message });
      throw error;
    }
  });

  for (const [pathSuffix, action] of [
    ['release', 'release'],
    ['resume-ai', 'resume_ai'],
    ['close', 'close'],
  ] as const) {
    app.post(
      `/v1/operator/conversations/:conversationId/${pathSuffix}`,
      operatorRoute,
      async (request, reply) => {
        if (!input.operatorService) return reply.code(503).send({ error: 'operator_service_unavailable' });
        const identity = requireOperatorIdentity(request);
        const params = z.object({ conversationId: conversationIdSchema }).safeParse(request.params);
        if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
        try {
          return await input.operatorService.transition({
            tenantId: identity.tenantId,
            operatorReference: identity.operatorReference,
            conversationId: params.data.conversationId,
            action,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'operator_action_failed';
          if (message === 'conversation_not_found') return reply.code(404).send({ error: message });
          if (message === 'conversation_operator_mismatch') return reply.code(409).send({ error: message });
          throw error;
        }
      },
    );
  }

  const operatorMessageBodySchema = z.object({
    requestId: z.string().uuid(),
    text: z.string().min(1).max(4000),
  });

  app.post('/v1/operator/conversations/:conversationId/messages', operatorRoute, async (request, reply) => {
    if (!input.operatorOutboundService) {
      return reply.code(503).send({ error: 'operator_outbound_service_unavailable' });
    }
    const identity = requireOperatorIdentity(request);
    const params = z.object({ conversationId: conversationIdSchema }).safeParse(request.params);
    const body = operatorMessageBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_request' });

    try {
      const result = await input.operatorOutboundService.send({
        tenantId: identity.tenantId,
        operatorReference: identity.operatorReference,
        ...body.data,
        conversationId: params.data.conversationId,
      });
      const status = result.state === 'DELIVERY_UNCERTAIN' ? 202 : 200;
      return reply.code(status).send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'operator_send_failed';
      if (message === 'conversation_not_found') return reply.code(404).send({ error: message });
      if (
        message === 'conversation_not_owned_by_operator'
        || message === 'operator_request_id_conflict'
        || message === 'operator_request_owner_conflict'
        || message === 'operator_send_in_progress'
      ) {
        return reply.code(409).send({ error: message });
      }
      if (
        message.startsWith('operator_provider_unavailable:')
        || message === 'operator_routing_unavailable'
      ) {
        return reply.code(503).send({ error: message });
      }
      throw error;
    }
  });

  app.get('/v1/operator/outbound/:requestId', operatorRoute, async (request, reply) => {
    if (!input.operatorOutboundService) {
      return reply.code(503).send({ error: 'operator_outbound_service_unavailable' });
    }
    const identity = requireOperatorIdentity(request);
    const params = z.object({ requestId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const result = await input.operatorOutboundService.status(
      identity.tenantId,
      params.data.requestId,
    );
    if (!result) return reply.code(404).send({ error: 'operator_outbound_not_found' });
    return result;
  });

  const approvalIdSchema = z.string().uuid();
  const approvalStatusSchema = z.enum([
    'PENDING','EXECUTING','EXECUTED','REJECTED','FAILED','EXPIRED',
  ]);
  const approvalListQuerySchema = z.object({
    status: approvalStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  });
  const approvalRejectBodySchema = z.object({
    reason: z.string().min(1).max(1000).optional(),
  });

  app.get('/v1/operator/approvals', supervisorRoute, async (request, reply) => {
    if (!input.approvalService) return reply.code(503).send({ error: 'approval_service_unavailable' });
    const identity = requireOperatorIdentity(request);
    const query = approvalListQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_request' });
    return input.approvalService.list({
      tenantId: identity.tenantId,
      ...query.data,
    });
  });

  app.get('/v1/operator/approvals/:approvalId', supervisorRoute, async (request, reply) => {
    if (!input.approvalService) return reply.code(503).send({ error: 'approval_service_unavailable' });
    const identity = requireOperatorIdentity(request);
    const params = z.object({ approvalId: approvalIdSchema }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const detail = await input.approvalService.detail(
      identity.tenantId,
      params.data.approvalId,
    );
    if (!detail) return reply.code(404).send({ error: 'approval_not_found' });
    return detail;
  });

  app.post('/v1/operator/approvals/:approvalId/approve', supervisorRoute, async (request, reply) => {
    if (!input.approvalService) return reply.code(503).send({ error: 'approval_service_unavailable' });
    const identity = requireOperatorIdentity(request);
    const params = z.object({ approvalId: approvalIdSchema }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      return await input.approvalService.approve({
        tenantId: identity.tenantId,
        operatorReference: identity.operatorReference,
        approvalId: params.data.approvalId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'approval_action_failed';
      if (message === 'approval_not_found') return reply.code(404).send({ error: message });
      if (message.startsWith('approval_not_pending:')) {
        return reply.code(409).send({ error: message });
      }
      throw error;
    }
  });

  app.post('/v1/operator/approvals/:approvalId/reject', supervisorRoute, async (request, reply) => {
    if (!input.approvalService) return reply.code(503).send({ error: 'approval_service_unavailable' });
    const identity = requireOperatorIdentity(request);
    const params = z.object({ approvalId: approvalIdSchema }).safeParse(request.params);
    const body = approvalRejectBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      return await input.approvalService.reject({
        tenantId: identity.tenantId,
        operatorReference: identity.operatorReference,
        reason: body.data.reason,
        approvalId: params.data.approvalId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'approval_action_failed';
      if (message === 'approval_not_found') return reply.code(404).send({ error: message });
      if (message.startsWith('approval_not_pending:')) {
        return reply.code(409).send({ error: message });
      }
      throw error;
    }
  });

  const adminTokenBodySchema = z.object({
    tenantId: tenantIdSchema,
    operatorReference: operatorReferenceSchema,
    role: operatorRoleSchema,
    label: z.string().min(1).max(200).optional(),
    expiresAt: z.coerce.date().nullable().optional(),
  });

  const adminCredentialRoute = {
    preHandler: internalApiAuth(input.config.INTERNAL_API_KEY),
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  };

  app.post(
    '/v1/admin/operator-tokens',
    adminCredentialRoute,
    async (request, reply) => {
      const body = adminTokenBodySchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
      const issued = await input.operatorAuthService.issue({
        ...body.data,
        actor: 'internal-admin',
      });
      return reply
        .header('Cache-Control', 'no-store')
        .header('Pragma', 'no-cache')
        .send(issued);
    },
  );

  app.get(
    '/v1/admin/operator-tokens',
    adminCredentialRoute,
    async (request, reply) => {
      const query = z.object({ tenantId: tenantIdSchema }).safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: 'invalid_request' });
      return input.operatorAuthService.list(query.data.tenantId);
    },
  );

  app.post(
    '/v1/admin/operator-tokens/:tokenId/revoke',
    adminCredentialRoute,
    async (request, reply) => {
      const params = z.object({ tokenId: z.string().uuid() }).safeParse(request.params);
      const body = z.object({ tenantId: tenantIdSchema }).safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_request' });
      const revoked = await input.operatorAuthService.revoke({
        tenantId: body.data.tenantId,
        tokenId: params.data.tokenId,
        actor: 'internal-admin',
      });
      if (!revoked) return reply.code(404).send({ error: 'operator_token_not_found' });
      return { revoked: true };
    },
  );

  return app;
}
