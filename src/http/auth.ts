import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  OperatorAuthService,
  OperatorIdentity,
  OperatorRole,
} from '../business/operator-auth-service.js';
import { constantTimeEquals } from '../security/crypto.js';

export function internalApiAuth(expected: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    const value = header?.startsWith('Bearer ') ? header.slice(7) : '';
    if (!value || !constantTimeEquals(value, expected)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  };
}

export type OperatorAuthenticatedRequest = FastifyRequest & {
  operatorIdentity?: OperatorIdentity;
};

export function operatorApiAuth(
  service: OperatorAuthService,
  allowedRoles: OperatorRole[] = ['OPERATOR','SUPERVISOR','ADMIN'],
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return reply.code(401).send({ error: 'unauthorized' });

    const identity = await service.authenticate(token);
    if (!identity) return reply.code(401).send({ error: 'unauthorized' });
    if (!allowedRoles.includes(identity.role)) {
      return reply.code(403).send({ error: 'forbidden' });
    }

    (request as OperatorAuthenticatedRequest).operatorIdentity = identity;
  };
}

export function requireOperatorIdentity(request: FastifyRequest): OperatorIdentity {
  const identity = (request as OperatorAuthenticatedRequest).operatorIdentity;
  if (!identity) throw new Error('operator_identity_missing');
  return identity;
}
