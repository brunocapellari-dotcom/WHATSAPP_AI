import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const baseEnv = {
  APP_ENCRYPTION_KEY: 'a'.repeat(32),
  PII_HMAC_KEY: 'b'.repeat(32),
  INTERNAL_API_KEY: 'internal-api-key-123456',
};

describe('configuration safety', () => {
  it('enables zero-cost mode by default', () => {
    expect(loadConfig(baseEnv).ZERO_COST_MODE).toBe(true);
  });

  it('parses explicit boolean values safely', () => {
    expect(loadConfig({ ...baseEnv, ZERO_COST_MODE: 'false' }).ZERO_COST_MODE).toBe(false);
    expect(loadConfig({ ...baseEnv, ZERO_COST_MODE: '0' }).ZERO_COST_MODE).toBe(false);
    expect(loadConfig({ ...baseEnv, META_GROUPS_ENABLED: 'false' }).META_GROUPS_ENABLED).toBe(false);
    expect(loadConfig({ ...baseEnv, META_GROUPS_ENABLED: 'true' }).META_GROUPS_ENABLED).toBe(true);
  });

  it('rejects billable Meta sending credentials while zero-cost mode is enabled', () => {
    expect(() => loadConfig({
      ...baseEnv,
      META_ACCESS_TOKEN: 'token',
      META_PHONE_NUMBER_ID: 'phone-id',
    })).toThrow(/ZERO_COST_MODE|billable/i);
  });

  it('allows complete Meta configuration only when zero-cost mode is explicitly disabled', () => {
    const config = loadConfig({
      ...baseEnv,
      ZERO_COST_MODE: 'false',
      META_VERIFY_TOKEN: 'verify',
      META_APP_SECRET: 'secret',
      META_ACCESS_TOKEN: 'token',
      META_PHONE_NUMBER_ID: 'phone-id',
    });
    expect(config.ZERO_COST_MODE).toBe(false);
    expect(config.META_PHONE_NUMBER_ID).toBe('phone-id');
  });

  it('rejects partial Meta configuration', () => {
    expect(() => loadConfig({
      ...baseEnv,
      ZERO_COST_MODE: 'false',
      META_ACCESS_TOKEN: 'token-only',
    })).toThrow();
    expect(() => loadConfig({
      ...baseEnv,
      ZERO_COST_MODE: 'false',
      META_VERIFY_TOKEN: 'verify-only',
    })).toThrow();
  });

  it('rejects external AI, transcription and AgroLog endpoints in zero-cost mode', () => {
    for (const [field, value] of [
      ['LOCAL_AI_BASE_URL', 'https://paid.example.com'],
      ['WHISPER_BASE_URL', 'https://speech.example.com'],
      ['AGROLOG_GATEWAY_URL', 'https://cloud.example.com'],
    ] as const) {
      const env: Record<string, string> = { ...baseEnv, [field]: value };
      if (field === 'AGROLOG_GATEWAY_URL') env.AGROLOG_GATEWAY_TOKEN = 'token';
      expect(() => loadConfig(env)).toThrow(/local\/private endpoint/i);
    }
  });

  it('accepts Docker/private service endpoints in zero-cost mode', () => {
    const config = loadConfig({
      ...baseEnv,
      LOCAL_AI_BASE_URL: 'http://ollama:11434',
      WHISPER_BASE_URL: 'http://whisper:8080',
      AGROLOG_GATEWAY_URL: 'http://agrolog.internal:8080',
      AGROLOG_GATEWAY_TOKEN: 'internal-token',
    });
    expect(config.LOCAL_AI_BASE_URL).toBe('http://ollama:11434');
    expect(config.WHISPER_BASE_URL).toBe('http://whisper:8080');
  });

  it('requires the zero-cost WPP provider tuple together but not a direct webhook secret', () => {
    expect(() => loadConfig({
      ...baseEnv,
      WPP_BASE_URL: 'http://wppconnect:21465',
    })).toThrow();

    const config = loadConfig({
      ...baseEnv,
      WPP_BASE_URL: 'http://wppconnect:21465',
      WPP_API_TOKEN: 'wpp-token',
      WPP_COLLECTOR_ID: 'wpp-freight-default',
    });
    expect(config.WPP_WEBHOOK_SECRET).toBeUndefined();
  });

  it('rejects partial AgroLog HTTP configuration', () => {
    expect(() => loadConfig({
      ...baseEnv,
      ZERO_COST_MODE: 'false',
      AGROLOG_GATEWAY_URL: 'https://agrolog.example.test',
    })).toThrow();
  });

  it('rejects production example secrets and example database credentials', () => {
    expect(() => loadConfig({
      ...baseEnv,
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://whatsapp_ai:change_me@db/whatsapp_ai',
      METRICS_TOKEN: 'metrics-token-123456',
      APP_ENCRYPTION_KEY: 'replace-with-32-byte-minimum-secret',
    })).toThrow();
  });
});
