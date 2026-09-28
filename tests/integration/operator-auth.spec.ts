import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { OperatorAuthService } from '../../src/business/operator-auth-service.js';
import { PostgresAuditSink } from '../../src/infra/audit.js';

const databaseUrl = process.env.DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;

run('operator authentication', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const tenantA = 'operator-auth-a-' + randomUUID();
  const tenantB = 'operator-auth-b-' + randomUUID();

  afterAll(async () => {
    for (const tenantId of [tenantA, tenantB]) {
      await pool.query('DELETE FROM operator_tokens WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM audit_logs WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM tenants WHERE tenant_id=$1', [tenantId]);
    }
    await pool.end();
  });

  it('issues a one-time plaintext token but persists only its hash and bound identity', async () => {
    await pool.query(
      'INSERT INTO tenants(tenant_id,name) VALUES($1,$2),($3,$4)',
      [tenantA, 'Operator Auth A', tenantB, 'Operator Auth B'],
    );

    const service = new OperatorAuthService(pool, new PostgresAuditSink(pool));
    const issued = await service.issue({
      tenantId: tenantA,
      operatorReference: 'alice',
      role: 'SUPERVISOR',
      label: 'Alice workstation',
      actor: 'internal-admin',
    });

    expect(issued.token).toMatch(/^op1\./);
    expect(issued.tenantId).toBe(tenantA);
    expect(issued.operatorReference).toBe('alice');
    expect(issued.role).toBe('SUPERVISOR');

    const stored = await pool.query(
      'SELECT token_hash,operator_reference,role FROM operator_tokens WHERE token_id=$1',
      [issued.tokenId],
    );
    expect(stored.rows[0].token_hash).not.toBe(issued.token);
    expect(stored.rows[0]).toMatchObject({
      operator_reference: 'alice',
      role: 'SUPERVISOR',
    });

    const identity = await service.authenticate(issued.token);
    expect(identity).toEqual({
      tenantId: tenantA,
      operatorReference: 'alice',
      role: 'SUPERVISOR',
      tokenId: issued.tokenId,
    });

    const forgedTenant = issued.token.replace(
      issued.token.split('.')[1]!,
      Buffer.from(tenantB, 'utf8').toString('base64url'),
    );
    expect(await service.authenticate(forgedTenant)).toBeNull();

    const forgedSecret = issued.token.slice(0, -1) + (issued.token.endsWith('A') ? 'B' : 'A');
    expect(await service.authenticate(forgedSecret)).toBeNull();

    const listed = await service.list(tenantA);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(issued.token);
    expect(JSON.stringify(listed)).not.toContain(stored.rows[0].token_hash);

    expect(await service.revoke({
      tenantId: tenantA,
      tokenId: issued.tokenId,
      actor: 'internal-admin',
    })).toBe(true);
    expect(await service.authenticate(issued.token)).toBeNull();
  });

  it('rejects expired operator tokens', async () => {
    const service = new OperatorAuthService(pool, new PostgresAuditSink(pool));
    const issued = await service.issue({
      tenantId: tenantA,
      operatorReference: 'expired-user',
      role: 'OPERATOR',
      expiresAt: new Date(Date.now() - 60_000),
      actor: 'internal-admin',
    });

    expect(await service.authenticate(issued.token)).toBeNull();
  });
});
