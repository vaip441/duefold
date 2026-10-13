import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import {
  beginOidc,
  OIDC_BROWSER_COOKIE,
  OIDC_BROWSER_COOKIE_OPTIONS,
  OIDC_TRANSACTION_SECONDS,
  persistOidcTransaction,
} from '../auth/oidc.ts';
import { networkCorrelation } from '../auth/otp.ts';
import { SIGN_IN_FAILED_PATH } from './oidc-callback.ts';

export const schema = {
  querystring: Type.Object({}, { additionalProperties: false }),
  response: {
    302: Type.Null(),
  },
};

export function createHandler(runtime: WebRuntime) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<null> => {
    const transaction = await beginOidc(runtime.oidc, runtime.oidcRedirectUri);
    const network = networkCorrelation(request.ip, runtime.clock.now(), runtime.networkHmacKey);
    try {
      await persistOidcTransaction(runtime.authPool, transaction, network.hmac);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'OIDC_BEGIN_RATE_LIMITED') throw error;
      request.log.warn({
        event: 'auth.oidc.refused',
        code: 'OIDC_BEGIN_RATE_LIMITED',
        correlation: request.id,
      });
      void reply.redirect(SIGN_IN_FAILED_PATH);
      return null;
    }
    reply.setCookie(OIDC_BROWSER_COOKIE, transaction.browserBinding, {
      ...OIDC_BROWSER_COOKIE_OPTIONS,
      maxAge: OIDC_TRANSACTION_SECONDS,
    });
    void reply.redirect(transaction.authorizationUrl.toString());
    return null;
  };
}
export function handler(): never {
  throw new Error('OIDC route runtime not initialized');
}
