import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import * as oidc from 'openid-client';
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
 * `code`, `state`, `iss`, and the presence of `error`, and the token exchange
 * rebuilds the callback URL from `runtime.oidcRedirectUri` with only those
 * protocol parameters reattached, so any other parameter cannot reach the
 * provider request, the session, the log, or the response.
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

/**
 * Maps a thrown sign-in failure to a closed-set telemetry code.
 *
 * Only this module's own error identifiers and a small set of stable OAuth error
 * classes/codes are recognized. Provider descriptions, response bodies, status
 * details, and library messages never reach telemetry. Anything unclassified
 * becomes `OIDC_EXCHANGE_FAILED`.
 */
export function signInRefusalCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const known = [
    'OIDC_TRANSACTION_INVALID',
    'OIDC_REQUIRED_CLAIMS_MISSING',
    'OIDC_TOKEN_EXPIRED',
    'OIDC_AUTH_TIME_REQUIRED',
    'OIDC_AUTH_TIME_STALE',
    'OIDC_VERIFIED_EMAIL_REQUIRED',
    'MEMBER_INVITATION_REQUIRED',
    'BOOTSTRAP_IDENTITY_NOT_ALLOWED',
    'OWNER_ALREADY_EXISTS',
  ];
  if (known.includes(message)) return message;
  if (error instanceof oidc.ResponseBodyError) {
    if (error.error === 'invalid_client' || error.error === 'unauthorized_client')
      return 'OIDC_CLIENT_REJECTED';
    if (error.error === 'invalid_grant') return 'OIDC_GRANT_REJECTED';
    return 'OIDC_TOKEN_ENDPOINT_REJECTED';
  }
  if (error instanceof oidc.AuthorizationResponseError)
    return 'OIDC_AUTHORIZATION_RESPONSE_REJECTED';
  if (error instanceof oidc.ClientError) {
    if (error.code === 'OAUTH_JWT_CLAIM_COMPARISON') return 'OIDC_TOKEN_CLAIMS_REJECTED';
    if (error.code === 'OAUTH_JWT_TIMESTAMP_CHECK') return 'OIDC_TOKEN_TIME_REJECTED';
    if (error.code === 'OAUTH_INVALID_RESPONSE' || error.code === 'OAUTH_PARSE_ERROR')
      return 'OIDC_PROVIDER_RESPONSE_INVALID';
  }
  return 'OIDC_EXCHANGE_FAILED';
}

interface CallbackQuery {
  readonly code: string | null;
  readonly state: string | null;
  readonly issuer: string | null;
  readonly idpError: boolean;
}
function callbackQuery(value: unknown): CallbackQuery {
  if (typeof value !== 'object' || value === null) throw new Error('invalid callback query');
  const record: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(value));
  const code = record['code'];
  const state = record['state'];
  const issuer = record['iss'];
  return {
    code: typeof code === 'string' ? code : null,
    state: typeof state === 'string' ? state : null,
    issuer: typeof issuer === 'string' ? issuer : null,
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
      /*
       * `iss` must be carried through. RFC 9207 lets a provider advertise
       * `authorization_response_iss_parameter_supported`, and Google does, so
       * oauth4webapi REQUIRES the parameter on the authorization response and
       * rejects the exchange with 'response parameter "iss" (issuer) missing'
       * without it. Rebuilding the URL from only `code` and `state` silently
       * dropped it, which made every Google sign-in fail inside the library.
       *
       * The value is not trusted here: the library compares it against the
       * discovered issuer and rejects a mismatch, which is the mix-up defence the
       * parameter exists for. Forwarding only a string keeps the reconstruction
       * free of any other attacker-supplied parameter.
       */
      callbackUrl.search = new URLSearchParams({
        code,
        state,
        ...(query.issuer === null ? {} : { iss: query.issuer }),
      }).toString();
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
      //
      // The reason is logged as a closed-set code because the browser outcome is
      // deliberately uniform: without it a failed sign-in was a redacted
      // REQUEST_FAILED with no audit row, so the surface told the operator to ask
      // an administrator to check access while giving that administrator nothing
      // to check. The code names a cause only; no email, subject, issuer, state,
      // or token material is recorded, and provider text is never forwarded.
      request.log.warn({
        err: error,
        event: 'auth.oidc.refused',
        code: signInRefusalCode(error),
        correlation: request.id,
      });
      void reply.redirect(SIGN_IN_FAILED_PATH);
      return null;
    }
  };
}
export function handler(): never {
  throw new Error('OIDC route runtime not initialized');
}
