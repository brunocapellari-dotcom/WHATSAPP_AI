import { z } from 'zod';

const EnvBooleanSchema = z.preprocess((raw) => {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const value = raw.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(value)) return true;
    if (['false', '0', 'no', 'off', ''].includes(value)) return false;
  }
  return raw;
}, z.boolean());

function addMissingPairIssue(
  ctx: z.RefinementCtx,
  value: Record<string, unknown>,
  left: string,
  right: string,
) {
  const hasLeft = Boolean(value[left]);
  const hasRight = Boolean(value[right]);
  if (hasLeft === hasRight) return;
  const missing = hasLeft ? right : left;
  ctx.addIssue({
    code: 'custom',
    path: [missing],
    message: `${left} and ${right} must be configured together`,
  });
}

function isInternalEndpoint(raw: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host === 'host.docker.internal') return true;
  if (!host.includes('.')) return true; // Docker/Compose service DNS.
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  const octets = host.split('.').map(Number);
  if (octets.length === 4 && octets.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) {
    if (octets[0] === 10 || octets[0] === 127) return true;
    if (octets[0] === 192 && octets[1] === 168) return true;
    if (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31) return true;
  }
  return false;
}

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  ZERO_COST_MODE: EnvBooleanSchema.default(true),
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

  META_VERIFY_TOKEN: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_ACCESS_TOKEN: z.string().optional(),
  META_PHONE_NUMBER_ID: z.string().optional(),
  META_GRAPH_VERSION: z.string().default('v26.0'),
  META_GROUPS_ENABLED: EnvBooleanSchema.default(false),

  WPP_BASE_URL: z.string().url().optional(),
  WPP_API_TOKEN: z.string().optional(),
  WPP_COLLECTOR_ID: z.string().min(1).optional(),
  WPP_SESSION: z.string().min(1).default('default'),
  WPP_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(5_000).max(10 * 60_000).default(15_000),
  WPP_WEBHOOK_SECRET: z.string().min(32).optional(),

  LOCAL_AI_BASE_URL: z.string().url().default('http://127.0.0.1:11434'),
  LOCAL_AI_MODEL: z.string().min(1).default('qwen3-vl:4b-instruct'),
  LOCAL_AI_MODEL_DIGEST: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  LOCAL_AI_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(10 * 60_000).default(120_000),
  WHISPER_BASE_URL: z.string().url().default('http://127.0.0.1:8080'),
  WHISPER_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(10 * 60_000).default(120_000),
  DOCUMENT_PARSER_BASE_URL: z.string().url().default('http://127.0.0.1:8090'),
  DOCUMENT_PARSER_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(20_000),
  PDF_MAX_PAGES: z.coerce.number().int().min(1).max(50).default(12),

  AGROLOG_GATEWAY_URL: z.string().url().optional(),
  AGROLOG_GATEWAY_TOKEN: z.string().optional(),
  AGROLOG_EXPORT_DIR: z.string().min(1).default('/data/agrolog-export'),
  CLAMAV_HOST: z.string().default('localhost'),
  CLAMAV_PORT: z.coerce.number().int().default(3310),
  ATTACHMENT_MAX_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  WEBHOOK_MAX_BYTES: z.coerce.number().int().positive().max(16 * 1024 * 1024).default(4 * 1024 * 1024),
}).superRefine((value, ctx) => {
  addMissingPairIssue(ctx, value as Record<string, unknown>, 'META_VERIFY_TOKEN', 'META_APP_SECRET');
  addMissingPairIssue(ctx, value as Record<string, unknown>, 'META_ACCESS_TOKEN', 'META_PHONE_NUMBER_ID');
  addMissingPairIssue(ctx, value as Record<string, unknown>, 'AGROLOG_GATEWAY_URL', 'AGROLOG_GATEWAY_TOKEN');

  const wppCore = [value.WPP_BASE_URL, value.WPP_API_TOKEN, value.WPP_COLLECTOR_ID].filter(Boolean).length;
  if (wppCore > 0 && wppCore < 3) {
    for (const key of ['WPP_BASE_URL', 'WPP_API_TOKEN', 'WPP_COLLECTOR_ID'] as const) {
      if (!value[key]) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'WPP_BASE_URL, WPP_API_TOKEN and WPP_COLLECTOR_ID must be configured together',
        });
      }
    }
  }

  if (value.ZERO_COST_MODE) {
    if (value.META_ACCESS_TOKEN || value.META_PHONE_NUMBER_ID) {
      ctx.addIssue({
        code: 'custom',
        path: ['META_ACCESS_TOKEN'],
        message: 'Meta Cloud sending is blocked while ZERO_COST_MODE=true because provider usage may be billable',
      });
    }
    for (const [field, endpoint] of [
      ['LOCAL_AI_BASE_URL', value.LOCAL_AI_BASE_URL],
      ['WHISPER_BASE_URL', value.WHISPER_BASE_URL],
      ['DOCUMENT_PARSER_BASE_URL', value.DOCUMENT_PARSER_BASE_URL],
      ...(value.AGROLOG_GATEWAY_URL ? [['AGROLOG_GATEWAY_URL', value.AGROLOG_GATEWAY_URL] as const] : []),
    ] as const) {
      if (!isInternalEndpoint(endpoint)) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} must point to a local/private endpoint while ZERO_COST_MODE=true`,
        });
      }
    }
  }

  if (value.NODE_ENV === 'production') {
    if (!value.METRICS_TOKEN) {
      ctx.addIssue({ code: 'custom', path: ['METRICS_TOKEN'], message: 'METRICS_TOKEN is required in production' });
    }
    if (value.ZERO_COST_MODE && !value.LOCAL_AI_MODEL_DIGEST) {
      ctx.addIssue({
        code: 'custom',
        path: ['LOCAL_AI_MODEL_DIGEST'],
        message: 'LOCAL_AI_MODEL_DIGEST is required in production to prevent silent local-model drift',
      });
    }
    if (value.DATABASE_URL.includes('change_me')) {
      ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'production DATABASE_URL cannot use the example credential' });
    }

    const secretFields = [
      ['APP_ENCRYPTION_KEY', value.APP_ENCRYPTION_KEY],
      ['PII_HMAC_KEY', value.PII_HMAC_KEY],
      ['INTERNAL_API_KEY', value.INTERNAL_API_KEY],
    ] as const;
    for (const [field, secret] of secretFields) {
      if (/replace|change[_-]?me/i.test(secret)) {
        ctx.addIssue({ code: 'custom', path: [field], message: `${field} cannot use an example placeholder in production` });
      }
    }
  }
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return ConfigSchema.parse(env);
}
