import { Pool } from 'pg';
import { loadConfig } from './config.js';
import { JobQueue } from './infra/job-queue.js';
import { AgroLogOutboxPublisher } from './infra/agrolog-outbox.js';
import { QuarantineRetention } from './infra/retention.js';

const config = loadConfig();
const workerDatabaseUrl = config.WORKER_DATABASE_URL ?? config.DATABASE_URL;

if (config.NODE_ENV === 'production' && !config.WORKER_DATABASE_URL) {
  throw new Error('WORKER_DATABASE_URL is required in production for the privileged cross-tenant worker role');
}

const pool = new Pool({
  connectionString: workerDatabaseUrl,
  max: 10,
  application_name: 'whatsapp-ai-worker',
});
const queue = new JobQueue(workerDatabaseUrl);
const retention = new QuarantineRetention(pool);

const publisher = config.AGROLOG_GATEWAY_URL && config.AGROLOG_GATEWAY_TOKEN
  ? new AgroLogOutboxPublisher(pool, {
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
});

const outboxTimer = publisher
  ? setInterval(() => {
      void queue.scheduleOutbox();
    }, 5_000)
  : undefined;

const retentionTimer = setInterval(() => {
  void queue.scheduleQuarantinePurge();
}, 15 * 60 * 1000);

if (publisher) void queue.scheduleOutbox();
void queue.scheduleQuarantinePurge();

const shutdown = async () => {
  if (outboxTimer) clearInterval(outboxTimer);
  clearInterval(retentionTimer);
  await queue.stop();
  await pool.end();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
