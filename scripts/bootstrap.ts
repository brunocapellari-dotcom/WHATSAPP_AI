import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
const [tenantId, name, collectorId, provider, purpose = 'FREIGHT_INTELLIGENCE', webhookSecret] = process.argv.slice(2);
if (!tenantId || !name || !collectorId || !provider) {
  throw new Error('Usage: npm run bootstrap -- <tenantId> <name> <collectorId> <provider> [BUSINESS|FREIGHT_INTELLIGENCE] [webhookSecret]');
}

const hash = webhookSecret ? createHash('sha256').update(webhookSecret).digest('hex') : null;
const account = provider === 'wppconnect'
  ? config.WPP_SESSION
  : provider === 'meta-cloud'
    ? config.META_PHONE_NUMBER_ID ?? 'meta-cloud'
    : provider;

const pool = new Pool({ connectionString: config.DATABASE_URL });
try {
  await pool.query(
    `INSERT INTO tenants(tenant_id,name)
     VALUES($1,$2)
     ON CONFLICT(tenant_id) DO UPDATE
       SET name=EXCLUDED.name, updated_at=now()`,
    [tenantId, name],
  );
  await pool.query(
    `INSERT INTO collectors(
       collector_id,tenant_id,provider,account,source_type,purpose,status,
       retry_policy,rate_limit,health,version,webhook_secret_hash
     )
     VALUES($1,$2,$3,$4,'reconciliation',$5,'HEALTHY','{}','{}','{}','1.0.0',$6)
     ON CONFLICT(collector_id) DO UPDATE SET
       tenant_id=EXCLUDED.tenant_id,
       provider=EXCLUDED.provider,
       account=EXCLUDED.account,
       source_type=EXCLUDED.source_type,
       purpose=EXCLUDED.purpose,
       webhook_secret_hash=EXCLUDED.webhook_secret_hash,
       updated_at=now()`,
    [collectorId, tenantId, provider, account, purpose, hash],
  );
  console.log(`bootstrapped tenant=${tenantId} collector=${collectorId} account=${account}`);
} finally {
  await pool.end();
}
