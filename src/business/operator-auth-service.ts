import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { AuditSink } from '../domain/ports.js';
import { sha256 } from '../security/crypto.js';
import { tenantQuery } from '../infra/tenant-db.js';

export type OperatorRole = 'OPERATOR' | 'SUPERVISOR' | 'ADMIN';

export type OperatorIdentity = {
  tenantId: string;
  operatorReference: string;
  role: OperatorRole;
  tokenId: string;
};

function encodeTenantId(tenantId: string): string {
  return Buffer.from(tenantId, 'utf8').toString('base64url');
}

function decodeTenantId(encoded: string): string | null {
  try {
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    if (!decoded || decoded.length > 128) return null;
    if (encodeTenantId(decoded) !== encoded) return null;
    return decoded;
  } catch {
    return null;
  }
}

function parseOperatorToken(token: string): { tenantId: string; hash: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'op1') return null;
  const tenantId = decodeTenantId(parts[1] ?? '');
  const secret = parts[2] ?? '';
  if (!tenantId || secret.length < 32) return null;
  return { tenantId, hash: sha256(token) };
}

export class OperatorAuthService {
  constructor(
    private readonly pool: Pool,
    private readonly audit: AuditSink,
  ) {}

  async issue(input: {
    tenantId: string;
    operatorReference: string;
    role: OperatorRole;
    label?: string;
    expiresAt?: Date | null;
    actor: string;
  }) {
    const tokenId = randomUUID();
    const token = `op1.${encodeTenantId(input.tenantId)}.${randomBytes(32).toString('base64url')}`;
    const tokenHash = sha256(token);

    await tenantQuery(
      this.pool,
      input.tenantId,
      `INSERT INTO operator_tokens(
         token_id,tenant_id,operator_reference,role,label,token_hash,expires_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        tokenId,
        input.tenantId,
        input.operatorReference,
        input.role,
        input.label ?? null,
        tokenHash,
        input.expiresAt ?? null,
      ],
    );

    await this.audit.write({
      tenantId: input.tenantId,
      actor: input.actor,
      action: 'operator_token_issued',
      outcome: 'ALLOW',
      target: tokenId,
      metadata: {
        operatorReference: input.operatorReference,
        role: input.role,
        label: input.label ?? null,
      },
    });

    return {
      tokenId,
      token,
      tenantId: input.tenantId,
      operatorReference: input.operatorReference,
      role: input.role,
      expiresAt: input.expiresAt ?? null,
    };
  }

  async authenticate(token: string): Promise<OperatorIdentity | null> {
    const parsed = parseOperatorToken(token);
    if (!parsed) return null;

    const result = await tenantQuery<{
      token_id: string;
      operator_reference: string;
      role: OperatorRole;
    }>(
      this.pool,
      parsed.tenantId,
      `UPDATE operator_tokens
       SET last_used_at=now(),updated_at=now()
       WHERE tenant_id=$1
         AND token_hash=$2
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > now())
       RETURNING token_id,operator_reference,role`,
      [parsed.tenantId, parsed.hash],
    );

    const row = result.rows[0];
    if (!row) return null;
    return {
      tenantId: parsed.tenantId,
      operatorReference: row.operator_reference,
      role: row.role,
      tokenId: row.token_id,
    };
  }

  async list(tenantId: string) {
    const result = await tenantQuery<{
      token_id: string;
      operator_reference: string;
      role: OperatorRole;
      label: string | null;
      expires_at: Date | null;
      last_used_at: Date | null;
      revoked_at: Date | null;
      created_at: Date;
    }>(
      this.pool,
      tenantId,
      `SELECT
         token_id,operator_reference,role,label,expires_at,last_used_at,revoked_at,created_at
       FROM operator_tokens
       WHERE tenant_id=$1
       ORDER BY created_at DESC
       LIMIT 500`,
      [tenantId],
    );

    return result.rows.map((row) => ({
      tokenId: row.token_id,
      operatorReference: row.operator_reference,
      role: row.role,
      label: row.label,
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at,
      createdAt: row.created_at,
    }));
  }

  async revoke(input: {
    tenantId: string;
    tokenId: string;
    actor: string;
  }): Promise<boolean> {
    const result = await tenantQuery(
      this.pool,
      input.tenantId,
      `UPDATE operator_tokens
       SET revoked_at=COALESCE(revoked_at,now()),updated_at=now()
       WHERE tenant_id=$1 AND token_id=$2
       RETURNING token_id`,
      [input.tenantId, input.tokenId],
    );

    if (result.rowCount === 1) {
      await this.audit.write({
        tenantId: input.tenantId,
        actor: input.actor,
        action: 'operator_token_revoked',
        outcome: 'ALLOW',
        target: input.tokenId,
      });
      return true;
    }
    return false;
  }
}
