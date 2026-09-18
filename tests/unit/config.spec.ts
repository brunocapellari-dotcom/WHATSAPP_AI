import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const baseEnv = {
  APP_ENCRYPTION_KEY: 'a'.repeat(32),
  PII_HMAC_KEY: 'b'.repeat(32),
  INTERNAL_API_KEY: 'internal-api-key-123456',
  META_VERIFY_TOKEN: 'verify-token',
  META_APP_SECRET: 'meta-app-secret',
};

describe('configuration safety', () => {
  it('parses explicit false boolean values as false', () => {
    expect(loadConfig({ ...baseEnv, META_GROUPS_ENABLED: 'false' }).META_GROUPS_ENABLED).toBe(false);
    expect(loadConfig({ ...baseEnv, META_GROUPS_ENABLED: '0' }).META_GROUPS_ENABLED).toBe(false);
  });

  it('parses explicit true boolean values as true', () => {
    expect(loadConfig({ ...baseEnv, META_GROUPS_ENABLED: 'true' }).META_GROUPS_ENABLED).toBe(true);
    expect(loadConfig({ ...baseEnv, META_GROUPS_ENABLED: '1' }).META_GROUPS_ENABLED).toBe(true);
  });

  it('rejects partial Meta sending configuration', () => {
    expect(() => loadConfig({ ...baseEnv, META_ACCESS_TOKEN: 'token-only' })).toThrow();
  });

  it('rejects partial WPPConnect configuration', () => {
    expect(() => loadConfig({ ...baseEnv, WPP_BASE_URL: 'https://example.test' })).toThrow();
  });

  it('rejects partial AgroLog configuration', () => {
    expect(() => loadConfig({ ...baseEnv, AGROLOG_GATEWAY_URL: 'https://agrolog.example.test' })).toThrow();
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
