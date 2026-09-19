import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedSession } from '../../../../apps/web/src/authenticate.ts';

/**
 * Session bootstrap for the browser client.
 *
 * The browser cannot read the HttpOnly session cookie, so without this route it
 * cannot tell whether it is signed in, or whether the principal is a member or a
 * viewer — and therefore cannot choose the correct sign-out route.
 *
 * It is deliberately minimal. It returns no email, identifier, global role, room
 * assignment, organization detail, or correlation identifier, and no CSRF token:
 * the token lives in the readable `__Host-duefold_csrf` cookie set at issuance.
 *
 * Absent, expired, and revoked sessions are indistinguishable: all three return
 * 200 with `authenticated: false`. It performs no write beyond the idle renewal
 * the shared session authenticator already does, and it deliberately reuses that
 * one authenticator rather than adding a second session-validation path.
 */
export const schema = {
  response: {
    200: Type.Union([
      Type.Object({ authenticated: Type.Literal(false) }, { additionalProperties: false }),
      Type.Object(
        {
          authenticated: Type.Literal(true),
          principal: Type.Union([Type.Literal('member'), Type.Literal('viewer')]),
        },
        { additionalProperties: false },
      ),
    ]),
  },
};

export type SessionBootstrap =
  | { readonly authenticated: false }
  | { readonly authenticated: true; readonly principal: 'member' | 'viewer' };

export function createHandler(
  _runtime: unknown,
  authenticate: (request: FastifyRequest) => Promise<AuthenticatedSession | null>,
) {
  return async (request: FastifyRequest): Promise<SessionBootstrap> => {
    const session = await authenticate(request);
    if (session === null) return { authenticated: false };
    return { authenticated: true, principal: session.principal.kind };
  };
}
export function handler(): never {
  throw new Error('session route runtime not initialized');
}
