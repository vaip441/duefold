import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import { beginOidc, persistOidcTransaction } from '../auth/oidc.ts';

export const schema = {
  querystring: Type.Object({}, { additionalProperties: false }),
  response: {
    302: Type.Null(),
  },
};

export function createHandler(runtime: WebRuntime) {
  return async (_request: FastifyRequest, reply: FastifyReply): Promise<null> => {
    const transaction = await beginOidc(runtime.oidc, runtime.oidcRedirectUri);
    await persistOidcTransaction(runtime.authPool, transaction);
    void reply.redirect(transaction.authorizationUrl.toString());
    return null;
  };
}
export function handler(): never {
  throw new Error('OIDC route runtime not initialized');
}
