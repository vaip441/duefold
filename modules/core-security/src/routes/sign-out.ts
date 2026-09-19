import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { PrincipalIdentity } from '../authorization.ts';
import { CLEARED_AUTHENTICATION_COOKIES, revokePrincipalSessions } from '../sessions.ts';

export const schema = {
  body: Type.Object({}, { additionalProperties: false }),
  response: {
    204: Type.Null(),
  },
};
export function createHandler(
  runtime: WebRuntime,
  session: {
    readonly sessionId: string;
    readonly familyId: string;
    readonly principal: PrincipalIdentity;
  },
  allDevices: boolean,
) {
  return async (_request: FastifyRequest, reply: FastifyReply): Promise<null> => {
    if (allDevices) await revokePrincipalSessions(runtime.authPool, session.principal);
    else await runtime.revokeSession(session.sessionId, session.principal);
    for (const cookie of CLEARED_AUTHENTICATION_COOKIES)
      reply.clearCookie(cookie.name, cookie.options);
    reply.code(204);
    return null;
  };
}
export function handler(): never {
  throw new Error('sign-out route runtime not initialized');
}
