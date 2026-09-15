import { z } from 'zod';

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().default('postgres://whatsapp_ai:change_me@localhost:5432/whatsapp_ai'),
  WORKER_DATABASE_URL: z.string().optional(),
  MIGRATION_DATABASE_URL: z.string().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(20),
  DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(100).default(5000),
  DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30000),
  APP_ENCRYPTION_KEY: z.string().min(32),
  PII_HMAC_KEY: z.string().min(32),
  INTERNAL_API_KEY: z.string().min(16),
  METRICS_TOKEN: z.string().min(16).optional(),
  META_VERIFY_TOKEN: z.string().min(1),
  META_APP_SECRET: z.string().min(1),
  META_ACCESS_TOKEN: z.string().optional(),
  META_PHONE_NUMBER_ID: z.string().optional(),
  META_GRAPH_VERSION: z.string().default('v26.0'),
  META_GROUPS_ENABLED: z.coerce.boolean().default(false),
  WPP_BASE_URL: z.string().url().optional(),
  WPP_API_TOKEN: z.string().optional(),
  WPP_WEBHOOK_SECRET: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-5.6-terra'),
  OPENAI_TRANSCRIPTION_MODEL: z.string().default('gpt-transcribe'),
  AGROLOG_GATEWAY_URL: z.string().url().optional(),
  AGROLOG_GATEWAY_TOKEN: z.string().optional(),
  CLAMAV_HOST: z.string().default('localhost'),
  CLAMAV_PORT: z.coerce.number().int().default(3310),
  ATTACHMENT_MAX_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
}).superRefine((value, ctx) => {
  if (value.NODE_ENV === 'production' && !value.METRICS_TOKEN) {
    ctx.addIssue({ code: 'custom', path: ['METRICS_TOKEN'], message: 'METRICS_TOKEN is required in production' });
  }
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return ConfigSchema.parse(env);
}
