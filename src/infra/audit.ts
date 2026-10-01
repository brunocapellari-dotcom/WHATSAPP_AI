import type { Pool } from 'pg';
import type { AuditSink } from '../domain/ports.js';
import { tenantQuery } from './tenant-db.js';

export class MemoryAuditSink implements AuditSink {
  readonly events: Parameters<AuditSink['write']>[0][] = [];
  async write(event: Parameters<AuditSink['write']>[0]) { this.events.push(event); }
}

export class PostgresAuditSink implements AuditSink {
  constructor(private readonly pool: Pool) {}
  async write(event: Parameters<AuditSink['write']>[0]) {
    await tenantQuery(
      this.pool, event.tenantId,
      `INSERT INTO audit_logs(tenant_id, actor, action, outcome, target, metadata) VALUES ($1,$2,$3,$4,$5,$6)`,
      [event.tenantId, event.actor, event.action, event.outcome, event.target ?? null, event.metadata ?? {}],
    );
  }
}
