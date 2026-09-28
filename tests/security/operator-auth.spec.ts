import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { OperatorAuthService } from '../../src/business/operator-auth-service.js';
import {
  operatorApiAuth,
  requireOperatorIdentity,
} from '../../src/http/auth.js';

function request(token?: string) {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as FastifyRequest;
}

function reply() {
  const state = { status: 200, body: undefined as unknown };
  const value = {
    code(status: number) {
      state.status = status;
      return value;
    },
    send(body: unknown) {
      state.body = body;
      return value;
    },
  } as unknown as FastifyReply;
  return { value, state };
}

describe('operator API auth', () => {
  it('rejects missing and invalid bearer tokens', async () => {
    const service = {
      authenticate: vi.fn().mockResolvedValue(null),
    } as unknown as OperatorAuthService;

    const missingReply = reply();
    await operatorApiAuth(service)(request(), missingReply.value);
    expect(missingReply.state.status).toBe(401);

    const invalidReply = reply();
    await operatorApiAuth(service)(request('bad-token'), invalidReply.value);
    expect(invalidReply.state.status).toBe(401);
  });

  it('blocks OPERATOR from supervisor-only routes', async () => {
    const service = {
      authenticate: vi.fn().mockResolvedValue({
        tenantId: 'tenant-a',
        operatorReference: 'alice',
        role: 'OPERATOR',
        tokenId: 'token-a',
      }),
    } as unknown as OperatorAuthService;
    const response = reply();
    const req = request('operator-token');

    await operatorApiAuth(service, ['SUPERVISOR','ADMIN'])(req, response.value);

    expect(response.state.status).toBe(403);
    expect(requireOperatorIdentity(req)).toMatchObject({
      tenantId: 'tenant-a',
      operatorReference: 'alice',
      role: 'OPERATOR',
    });
  });

  it('injects tenant-bound supervisor identity from the token', async () => {
    const service = {
      authenticate: vi.fn().mockResolvedValue({
        tenantId: 'tenant-b',
        operatorReference: 'supervisor-b',
        role: 'SUPERVISOR',
        tokenId: 'token-b',
      }),
    } as unknown as OperatorAuthService;
    const response = reply();
    const req = request('supervisor-token');

    await operatorApiAuth(service, ['SUPERVISOR','ADMIN'])(req, response.value);

    expect(response.state.status).toBe(200);
    expect(requireOperatorIdentity(req)).toEqual({
      tenantId: 'tenant-b',
      operatorReference: 'supervisor-b',
      role: 'SUPERVISOR',
      tokenId: 'token-b',
    });
  });
});
