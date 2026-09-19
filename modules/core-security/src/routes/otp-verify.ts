import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import { consumeOtp } from '../auth/otp.ts';
import { authenticationCookies, issueSession } from '../sessions.ts';

export const schema = {
  body: Type.Object(
    {
      challengeId: Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' }),
      code: Type.String({ pattern: '^\\d{8}$' }),
    },
    { additionalProperties: false },
  ),
  response: {
    200: Type.Object({ authenticated: Type.Literal(true) }, { additionalProperties: false }),
    401: Type.Object(
      { error: Type.Object({ code: Type.Literal('UNAUTHENTICATED'), message: Type.String() }) },
      { additionalProperties: false },
    ),
  },
};
interface VerifyBody {
  readonly challengeId: string;
  readonly code: string;
}
function verifyBody(value: unknown): VerifyBody {
  if (typeof value !== 'object' || value === null) throw new Error('invalid OTP verification');
  const record: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(value));
  if (typeof record['challengeId'] !== 'string' || typeof record['code'] !== 'string')
    throw new Error('invalid OTP verification');
  return { challengeId: record['challengeId'], code: record['code'] };
}
export function createHandler(runtime: WebRuntime) {
  return async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<
    | { readonly authenticated: true }
    | { readonly error: { readonly code: 'UNAUTHENTICATED'; readonly message: string } }
  > => {
    const body = verifyBody(request.body);
    const viewer = await consumeOtp({
      pool: runtime.authPool,
      challengeId: body.challengeId,
      code: body.code,
      digestKey: runtime.otpDigestKey,
      clock: runtime.clock,
    });
    if (viewer === null) {
      reply.code(401);
      return {
        error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' },
      };
    }
    const session = await issueSession(
      runtime.authPool,
      viewer,
      'otp',
      runtime.clock,
      runtime.sessionPolicy,
    );
    for (const cookie of authenticationCookies(session))
      reply.setCookie(cookie.name, cookie.value, cookie.options);
    return { authenticated: true };
  };
}
export function handler(): never {
  throw new Error('OTP route runtime not initialized');
}
