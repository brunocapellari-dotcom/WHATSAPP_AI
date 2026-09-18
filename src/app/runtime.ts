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
import { OpenAIStructuredModel } from '../infra/openai-model.js';
import { IngestionService } from './ingestion-service.js';
import { Metrics } from '../observability/metrics.js';
import { ClamAvScanner } from '../infra/clamav.js';
import { OpenAIMediaProcessor } from '../infra/media-processor.js';
import { PostgresAuditSink } from '../infra/audit.js';
import { buildPostgresBusinessTools } from '../business/postgres-tools.js';
import { OpenAIBusinessModel } from '../infra/openai-business-model.js';
import { AgentRuntime } from '../business/agent-runtime.js';
import { BusinessMessageService } from '../business/message-service.js';

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
  const llm = config.OPENAI_API_KEY
    ? new OpenAIStructuredModel({ apiKey: config.OPENAI_API_KEY, model: config.OPENAI_MODEL, observeUsage })
    : undefined;
  const freight = new FreightPipeline(messages, resolver, llm);
  const providers = new Map<string, WhatsAppProvider>();
  providers.set('meta-cloud', new MetaCloudProvider({
    accessToken: config.META_ACCESS_TOKEN,
    phoneNumberId: config.META_PHONE_NUMBER_ID,
    piiHmacKey: config.PII_HMAC_KEY,
    groupsEnabled: config.META_GROUPS_ENABLED,
    graphVersion: config.META_GRAPH_VERSION,
  }));
  if (config.WPP_BASE_URL && config.WPP_API_TOKEN) {
    providers.set('wppconnect', new WppConnectProvider({
      baseUrl: config.WPP_BASE_URL,
      apiToken: config.WPP_API_TOKEN,
      piiHmacKey: config.PII_HMAC_KEY,
      session: config.WPP_SESSION,
    }));
  }
  const clamav = config.OPENAI_API_KEY ? new ClamAvScanner(config.CLAMAV_HOST, config.CLAMAV_PORT) : undefined;
  const media = config.OPENAI_API_KEY
    ? {
        processor: new OpenAIMediaProcessor({
          apiKey: config.OPENAI_API_KEY,
          model: config.OPENAI_MODEL,
          transcriptionModel: config.OPENAI_TRANSCRIPTION_MODEL,
          observeUsage,
        }),
        scanner: clamav!,
        maxBytes: config.ATTACHMENT_MAX_BYTES,
      }
    : undefined;
  const audit = new PostgresAuditSink(pool);
  const conversations = new PostgresConversationStore(pool, config.APP_ENCRYPTION_KEY);
  const businessRuns = new PostgresBusinessRunStore(pool, config.APP_ENCRYPTION_KEY);
  const businessTools = buildPostgresBusinessTools(pool, config.PII_HMAC_KEY, audit);
  const businessModel = config.OPENAI_API_KEY
    ? new OpenAIBusinessModel({ apiKey: config.OPENAI_API_KEY, model: config.OPENAI_MODEL, observeUsage })
    : undefined;
  const businessRuntime = new AgentRuntime(businessTools, businessModel);
  const business = new BusinessMessageService(businessRuntime, conversations, businessRuns);
  const ingestion = new IngestionService(collectors, providers, quarantine, messages, freight, media, business);
  return { pool, messages, collectors, quarantine, webhookInbox, conversations, businessRuns, resolver, llm, freight, providers, ingestion, metrics, businessRuntime, clamav };
}
