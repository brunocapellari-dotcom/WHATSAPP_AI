import { Pool } from 'pg';
import type { AppConfig } from '../config.js';
import type { WhatsAppProvider } from '../domain/ports.js';
import { FreightPipeline } from '../freight/pipeline.js';
import { PostgresEntityResolver } from '../freight/entity-resolution.js';
import { PostgresMessageRepository } from '../infra/postgres-repository.js';
import { PostgresCollectorResolver } from '../infra/collectors.js';
import { EncryptedPostgresQuarantineStore } from '../infra/quarantine.js';
import { PostgresConversationStore } from '../infra/conversations.js';
import { PostgresBusinessRunStore } from '../infra/business-runs.js';
import { WebhookInbox } from '../infra/webhook-inbox.js';
import { MetaCloudProvider } from '../providers/meta-cloud-provider.js';
import { WppConnectProvider } from '../providers/wppconnect-provider.js';
import { LocalAiClient } from '../infra/local-ai-client.js';
import { LocalStructuredModel } from '../infra/local-structured-model.js';
import { LocalBusinessModel } from '../infra/local-business-model.js';
import { LocalMediaProcessor } from '../infra/local-media-processor.js';
import { IngestionService } from './ingestion-service.js';
import { Metrics } from '../observability/metrics.js';
import { ClamAvScanner } from '../infra/clamav.js';
import { PostgresAuditSink } from '../infra/audit.js';
import { buildPostgresBusinessTools } from '../business/postgres-tools.js';
import { AgentRuntime } from '../business/agent-runtime.js';
import { BusinessMessageService } from '../business/message-service.js';
import { OperatorService } from '../business/operator-service.js';
import { ApprovalService } from '../business/approval-service.js';
import { OperatorOutboundService } from '../business/operator-outbound-service.js';

export function buildRuntime(config: AppConfig) {
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    connectionTimeoutMillis: config.DATABASE_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: config.DATABASE_IDLE_TIMEOUT_MS,
    application_name: 'whatsapp-ai',
  });

  const metrics = new Metrics();
  const observeUsage = metrics.observeAi.bind(metrics);
  const messages = new PostgresMessageRepository(pool);
  const collectors = new PostgresCollectorResolver(pool);
  const quarantine = new EncryptedPostgresQuarantineStore(pool, config.APP_ENCRYPTION_KEY);
  const webhookInbox = new WebhookInbox(pool, config.APP_ENCRYPTION_KEY);
  const resolver = new PostgresEntityResolver(pool);

  const localAi = new LocalAiClient({
    baseUrl: config.LOCAL_AI_BASE_URL,
    model: config.LOCAL_AI_MODEL,
    timeoutMs: config.LOCAL_AI_TIMEOUT_MS,
    observeUsage,
  });
  const llm = new LocalStructuredModel(localAi);
  const freight = new FreightPipeline(messages, resolver, llm);

  const providers = new Map<string, WhatsAppProvider>();
  if (
    !config.ZERO_COST_MODE
    && config.META_ACCESS_TOKEN
    && config.META_PHONE_NUMBER_ID
  ) {
    providers.set('meta-cloud', new MetaCloudProvider({
      accessToken: config.META_ACCESS_TOKEN,
      phoneNumberId: config.META_PHONE_NUMBER_ID,
      piiHmacKey: config.PII_HMAC_KEY,
      groupsEnabled: config.META_GROUPS_ENABLED,
      graphVersion: config.META_GRAPH_VERSION,
    }));
  }

  if (config.WPP_BASE_URL && config.WPP_API_TOKEN) {
    providers.set('wppconnect', new WppConnectProvider({
      baseUrl: config.WPP_BASE_URL,
      apiToken: config.WPP_API_TOKEN,
      piiHmacKey: config.PII_HMAC_KEY,
      session: config.WPP_SESSION,
    }));
  }

  const clamav = new ClamAvScanner(config.CLAMAV_HOST, config.CLAMAV_PORT);
  const mediaProcessor = new LocalMediaProcessor({
    ai: localAi,
    whisperBaseUrl: config.WHISPER_BASE_URL,
    whisperTimeoutMs: config.WHISPER_TIMEOUT_MS,
    pdfMaxPages: config.PDF_MAX_PAGES,
  });
  const media = {
    processor: mediaProcessor,
    scanner: clamav,
    maxBytes: config.ATTACHMENT_MAX_BYTES,
  };

  const audit = new PostgresAuditSink(pool);
  const conversations = new PostgresConversationStore(pool, config.APP_ENCRYPTION_KEY);
  const businessRuns = new PostgresBusinessRunStore(pool, config.APP_ENCRYPTION_KEY);
  const businessTools = buildPostgresBusinessTools(pool, config.PII_HMAC_KEY, audit);
  const approvalService = new ApprovalService(
    pool,
    config.APP_ENCRYPTION_KEY,
    businessTools,
    audit,
  );
  const businessModel = new LocalBusinessModel(localAi);
  const businessRuntime = new AgentRuntime(
    businessTools,
    businessModel,
    approvalService,
  );
  const business = new BusinessMessageService(businessRuntime, conversations, businessRuns);
  const operatorService = new OperatorService(pool, audit);
  const operatorOutboundService = new OperatorOutboundService(
    pool,
    providers,
    conversations,
    config.APP_ENCRYPTION_KEY,
    audit,
  );
  const ingestion = new IngestionService(
    collectors,
    providers,
    quarantine,
    messages,
    freight,
    media,
    business,
  );

  return {
    pool,
    messages,
    collectors,
    quarantine,
    webhookInbox,
    conversations,
    businessRuns,
    resolver,
    llm,
    freight,
    providers,
    ingestion,
    metrics,
    businessRuntime,
    operatorService,
    operatorOutboundService,
    approvalService,
    clamav,
    localAi,
    mediaProcessor,
  };
}
