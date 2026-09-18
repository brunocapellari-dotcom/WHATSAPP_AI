import type { Pool } from 'pg';
import type { CollectorResolver, ResolvedCollector } from '../domain/ports.js';

export class MemoryCollectorResolver implements CollectorResolver {
  constructor(private readonly collectors: ResolvedCollector[]) {}

  async resolve(collectorId: string) {
    return this.collectors.find((x) => x.collectorId === collectorId) ?? null;
  }

  async recordSuccess() {}
  async recordFailure() {}
}

export class PostgresCollectorResolver implements CollectorResolver {
  constructor(private readonly pool: Pool) {}

  async resolve(collectorId: string): Promise<ResolvedCollector | null> {
    const result = await this.pool.query(
      `SELECT collector_id, tenant_id, provider, account, purpose, status, webhook_secret_hash
       FROM collectors
       WHERE collector_id=$1`,
      [collectorId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      collectorId: String(row.collector_id),
      tenantId: String(row.tenant_id),
      provider: String(row.provider),
      account: String(row.account),
      purpose: String(row.purpose) as ResolvedCollector['purpose'],
      status: String(row.status) as ResolvedCollector['status'],
      ...(row.webhook_secret_hash ? { webhookSecretHash: String(row.webhook_secret_hash) } : {}),
    };
  }

  async recordSuccess(collectorId: string, latencyMs: number, lastMessage?: Date): Promise<void> {
    await this.pool.query(
      `UPDATE collectors
       SET last_success=now(),
           last_message=COALESCE($2,last_message),
           latency_ms=$3,
           status=CASE WHEN status='DISABLED' THEN status ELSE 'HEALTHY' END,
           health=health - 'last_error',
           updated_at=now()
       WHERE collector_id=$1`,
      [collectorId, lastMessage ?? null, latencyMs],
    );
  }

  async recordFailure(collectorId: string, latencyMs: number, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE collectors
       SET last_failure=now(),
           latency_ms=$2,
           status=CASE WHEN status='DISABLED' THEN status ELSE 'DEGRADED' END,
           health=jsonb_set(health,'{last_error}',to_jsonb($3::text),true),
           updated_at=now()
       WHERE collector_id=$1`,
      [collectorId, latencyMs, error.slice(0, 500)],
    );
  }
}
