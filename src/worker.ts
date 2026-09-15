import { Pool } from 'pg';
import { loadConfig } from './config.js';
import { JobQueue } from './infra/job-queue.js';
import { AgroLogOutboxPublisher } from './infra/agrolog-outbox.js';

const config = loadConfig();
if (!config.AGROLOG_GATEWAY_URL || !config.AGROLOG_GATEWAY_TOKEN) throw new Error('AGROLOG gateway must be configured for worker');
const workerDatabaseUrl = config.WORKER_DATABASE_URL ?? config.DATABASE_URL;
if (config.NODE_ENV === 'production' && !config.WORKER_DATABASE_URL) throw new Error('WORKER_DATABASE_URL is required in production for the privileged cross-tenant worker role');
const pool = new Pool({ connectionString: workerDatabaseUrl, max: 10, application_name: 'whatsapp-ai-worker' });
const queue = new JobQueue(workerDatabaseUrl);
const publisher = new AgroLogOutboxPublisher(pool, { gatewayUrl: config.AGROLOG_GATEWAY_URL, token: config.AGROLOG_GATEWAY_TOKEN });
await queue.start();
await queue.workOutbox(async () => { await publisher.publishBatch(); });
const timer = setInterval(() => { void queue.scheduleOutbox(); }, 5_000);
void queue.scheduleOutbox();

const shutdown = async () => {
  clearInterval(timer);
  await queue.stop();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
