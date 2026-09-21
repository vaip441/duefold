import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
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
 * It does answer whether this principal may administer members, because the frame
 * has to decide whether to offer that destination at all. That is one boolean about
 * the caller themselves, not the role and not anyone else's access.
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
          /*
           * Whether this principal may administer members, which decides only whether
           * the Members view is OFFERED. It is not the authorization: `read_members`
           * refuses independently, and every mutation authorizes itself again.
           *
           * Not the global role. The role is not disclosed here and does not need to
           * be -- the question the frame has is "is there a destination for me", and
           * answering exactly that discloses strictly less than a role would. A plain
           * member previously received a tab that could only ever render a denial.
           */
          mayAdministerOrganization: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ]),
  },
};

export type SessionBootstrap =
  | { readonly authenticated: false }
  | {
      readonly authenticated: true;
      readonly principal: 'member' | 'viewer';
      readonly mayAdministerOrganization: boolean;
    };

export function createHandler(
  runtime: { readonly pool: Pool },
  authenticate: (request: FastifyRequest) => Promise<AuthenticatedSession | null>,
) {
  return async (request: FastifyRequest): Promise<SessionBootstrap> => {
    const session = await authenticate(request);
    if (session === null) return { authenticated: false };
    /* Asked of PostgreSQL rather than derived from the session, so a role change is
       reflected on the next bootstrap without a new sign-in. A viewer is never a
       member and is not asked. */
    const mayAdministerOrganization =
      session.principal.kind === 'member' &&
      (
        await runtime.pool.query<{ allowed: boolean }>(
          'SELECT may_administer_organization($1) AS allowed',
          [session.principal.id],
        )
      ).rows[0]?.allowed === true;
    return {
      authenticated: true,
      principal: session.principal.kind,
      mayAdministerOrganization,
    };
  };
}
export function handler(): never {
  throw new Error('session route runtime not initialized');
}
