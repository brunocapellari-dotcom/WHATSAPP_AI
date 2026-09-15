import type { FastifyReply, FastifyRequest } from 'fastify';
import { constantTimeEquals } from '../security/crypto.js';

export function internalApiAuth(expected: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    const value = header?.startsWith('Bearer ') ? header.slice(7) : '';
    if (!value || !constantTimeEquals(value, expected)) return reply.code(401).send({ error: 'unauthorized' });
  };
}
