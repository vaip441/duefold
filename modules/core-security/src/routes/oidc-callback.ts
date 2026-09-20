import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import {
  claimFirstOwner,
  consumeOidcTransaction,
  finishOidc,
  resolveOidcMember,
} from '../auth/oidc.ts';
import { authenticationCookies, issueSession } from '../sessions.ts';
import { requireCorrelationId } from '@duefold/shared/ids';

/**
 * `code`/`state` and `error`/`error_description` are both optional so an
 * identity-provider denial reaches the handler as a designed sign-in state
 * instead of failing schema validation with a 400. `error_description` is
 * accepted only so it does not break validation; it is attacker-influenced text
 * from an external system and is never read, redirected, logged, or rendered.
 *
 * `additionalProperties` is permissive here, unlike every other schema in this
 * codebase, because a redirect target is not an API this server defines. Real
 * providers append parameters of their own: Google returns `scope`, `authuser`,
 * `prompt`, and `hd`; Entra adds `session_state` and `client_info`. The app
 * configures Ajv with `removeAdditional: false`, so rejecting unknown properties
 * here answered 400 to every genuine Google callback before the handler ran, which
 * made member sign-in impossible. No test caught it because all of them sent only
 * the parameters this schema names.
 *
 * Nothing beyond the named properties is read. `callbackQuery` picks exactly
 * `code`, `state`, and the presence of `error`, and the token exchange rebuilds the
 * callback URL from `runtime.oidcRedirectUri` with only `code` and `state`
 * reattached, so an extra parameter cannot reach the provider request, the session,
 * the log, or the response.
 */
export const schema = {
  querystring: Type.Object(
    {
      code: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
      state: Type.Optional(Type.String({ minLength: 16, maxLength: 512 })),
      error: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      error_description: Type.Optional(Type.String({ maxLength: 2048 })),
      iss: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    },
    { additionalProperties: true },
  ),
  response: {
    302: Type.Null(),
  },
};

/** One neutral outcome for every failure class; the specific reason stays in audit. */
export const SIGN_IN_FAILED_PATH = '/sign-in?state=failed';

interface CallbackQuery {
  readonly code: string | null;
  readonly state: string | null;
  readonly idpError: boolean;
}
function callbackQuery(value: unknown): CallbackQuery {
  if (typeof value !== 'object' || value === null) throw new Error('invalid callback query');
  const record: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(value));
  const code = record['code'];
  const state = record['state'];
  return {
    code: typeof code === 'string' ? code : null,
    state: typeof state === 'string' ? state : null,
    idpError: typeof record['error'] === 'string',
  };
}

export function createHandler(runtime: WebRuntime) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<null> => {
    const query = callbackQuery(request.query);
    if (query.code === null || query.state === null) {
      // An identity-provider denial is a real sign-in journey and gets the
      // designed failure surface. A callback carrying neither an authorization
      // code nor a provider error is malformed rather than a user journey.
      if (!query.idpError) throw new Error('OIDC_CALLBACK_MALFORMED');
      void reply.redirect(SIGN_IN_FAILED_PATH);
      return null;
    }
    const code = query.code;
    const state = query.state;
    try {
      const transaction = await consumeOidcTransaction(runtime.authPool, state);
      const callbackUrl = new URL(runtime.oidcRedirectUri);
      callbackUrl.search = new URLSearchParams({ code, state }).toString();
      const identity = await finishOidc({
        config: runtime.oidc,
        callbackUrl,
        transaction,
      });
      let memberId: string;
      try {
        memberId = (await resolveOidcMember(runtime.authPool, identity)).memberId;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'MEMBER_INVITATION_REQUIRED')
          throw error;
        memberId = (
          await claimFirstOwner({
            pool: runtime.authPool,
            identity,
            allowlist: runtime.ownerAllowlist,
            organizationName: runtime.organizationName,
            correlationId: requireCorrelationId(request.id),
          })
        ).memberId;
      }
      const session = await issueSession(
        runtime.authPool,
        { kind: 'member', id: memberId, oidcAuthenticatedAt: identity.authenticatedAt },
        'oidc',
        runtime.clock,
        runtime.sessionPolicy,
      );
      for (const cookie of authenticationCookies(session))
        reply.setCookie(cookie.name, cookie.value, cookie.options);
      void reply.redirect(runtime.afterAuthenticationPath);
      return null;
    } catch (error) {
      // Transaction invalid, provider or token-exchange failure, invitation
      // required, bootstrap identity not allowed, and owner already exists all
      // collapse to one indistinguishable browser outcome. The specific reason
      // remains in the audit spine and the server log.
      request.log.warn({ err: error });
      void reply.redirect(SIGN_IN_FAILED_PATH);
      return null;
    }
  };
}
export function handler(): never {
  throw new Error('OIDC route runtime not initialized');
}
