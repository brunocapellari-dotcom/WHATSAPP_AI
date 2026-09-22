import { loadConfig } from './config.js';
import { buildRuntime } from './app/runtime.js';
import { buildHttpApp } from './http/app.js';

const config = loadConfig();
const runtime = buildRuntime(config);
const app = await buildHttpApp({
  config,
  collectors: runtime.collectors,
  providers: runtime.providers,
  webhookInbox: runtime.webhookInbox,
  metrics: runtime.metrics,
  pool: runtime.pool,
  clamav: runtime.clamav,
  localAi: runtime.localAi,
  mediaProcessor: runtime.mediaProcessor,
  operatorService: runtime.operatorService,
  approvalService: runtime.approvalService,
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await runtime.pool.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
