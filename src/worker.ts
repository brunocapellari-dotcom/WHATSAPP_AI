import { Pool } from 'pg';
import { loadConfig } from './config.js';
import { buildRuntime } from './app/runtime.js';
import { JobQueue } from './infra/job-queue.js';
import { AgroLogOutboxPublisher } from './infra/agrolog-outbox.js';
import { QuarantineRetention } from './infra/retention.js';
import { WebhookInbox } from './infra/webhook-inbox.js';

const config = loadConfig();
const workerDatabaseUrl = config.WORKER_DATABASE_URL ?? config.DATABASE_URL;

if (config.NODE_ENV === 'production' && !config.WORKER_DATABASE_URL) {
  throw new Error('WORKER_DATABASE_URL is required in production for the privileged cross-tenant worker role');
}

const privilegedPool = new Pool({
  connectionString: workerDatabaseUrl,
  max: 10,
  application_name: 'whatsapp-ai-worker-privileged',
});

const processingRuntime = buildRuntime(config);
const queue = new JobQueue(workerDatabaseUrl);
const retention = new QuarantineRetention(privilegedPool);
const inbox = new WebhookInbox(privilegedPool, config.APP_ENCRYPTION_KEY);

const publisher = config.AGROLOG_GATEWAY_URL && config.AGROLOG_GATEWAY_TOKEN
  ? new AgroLogOutboxPublisher(privilegedPool, {
      gatewayUrl: config.AGROLOG_GATEWAY_URL,
      token: config.AGROLOG_GATEWAY_TOKEN,
    })
  : undefined;

await queue.start();

if (publisher) {
  await queue.workOutbox(async () => {
    await publisher.publishBatch();
  });
}

await queue.workQuarantinePurge(async () => {
  await retention.purgeExpired();
  await inbox.purgeExpired();
});

let inboxDrainRunning = false;

async function drainInbox() {
  if (inboxDrainRunning) return;
  inboxDrainRunning = true;

  try {
    const batch = await inbox.claimBatch(20);
    for (const item of batch) {
      try {
        const rows = await processingRuntime.ingestion.ingest(
          item.provider,
          item.collectorId,
          item.payload,
        );
        for (const row of rows) {
          processingRuntime.metrics.messages.inc({
            provider: item.provider,
            disposition: row.disposition,
          });
        }
        processingRuntime.metrics.collectorHealth.set({
          collector: item.collectorId,
          provider: item.provider,
        }, 1);
        await inbox.complete(item.ingressId);
      } catch (error) {
        processingRuntime.metrics.failures.inc({ component: 'webhook-inbox-processing' });
        processingRuntime.metrics.collectorHealth.set({
          collector: item.collectorId,
          provider: item.provider,
        }, 0);
        await inbox.fail(
          item.ingressId,
          item.attempts,
          error instanceof Error ? error.message : 'webhook_processing_failed',
        );
      }
    }
  } finally {
    inboxDrainRunning = false;
  }
}

const inboxTimer = setInterval(() => {
  void drainInbox();
}, 1_000);

const outboxTimer = publisher
  ? setInterval(() => {
      void queue.scheduleOutbox();
    }, 5_000)
  : undefined;

const retentionTimer = setInterval(() => {
  void queue.scheduleQuarantinePurge();
}, 15 * 60 * 1000);

void drainInbox();
if (publisher) void queue.scheduleOutbox();
void queue.scheduleQuarantinePurge();

const shutdown = async () => {
  clearInterval(inboxTimer);
  if (outboxTimer) clearInterval(outboxTimer);
  clearInterval(retentionTimer);
  await queue.stop();
  await processingRuntime.pool.end();
  await privilegedPool.end();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
