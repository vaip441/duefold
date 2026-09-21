/**
 * One place that turns a server failure into designed copy.
 *
 * The rules here are security-bearing, not cosmetic:
 *
 * 1. A DENIED or REVOKED response is reported AS a refusal. Substituting an empty
 *    state for a rejection previously hid revocation from a viewer, and that is a
 *    security defect rather than a rough edge. An empty list and a refused request
 *    must never look the same.
 * 2. A CONFLICT offers a reload, never a retry. Retrying would resend a stale
 *    expected revision and overwrite whatever the other person just changed.
 * 3. Nothing carries server detail, an internal code, or a correlation id.
 */

import { ApiError } from '../api/client.ts';
import { translate } from '../i18n/translate.ts';

/**
 * The failure classes a surface presents DIFFERENTLY.
 *
 * `session-ended` is its own kind rather than folded into `plain` because its recovery
 * is different in kind: retrying a request on a session that no longer exists produces
 * another 401, so the surface must offer sign-in instead of a reload. A surface that
 * could not tell the two apart had to pick one and be wrong for the other.
 */
export type FailureKind =
  'conflict' | 'fresh-oidc' | 'denied' | 'session-ended' | 'offline' | 'plain';

export interface PresentedFailure {
  readonly kind: FailureKind;
  readonly title: string | null;
  readonly body: string;
  /** True only for a stale revision, where re-reading is the correct recovery. */
  readonly offerReload: boolean;
}

/**
 * Maps a failure onto copy.
 *
 * The stale-OIDC case is identified by the SERVER, never guessed from which
 * operation was attempted. Marking every grant and export 403 as
 * "re-authenticate" told members to sign in again when the real cause was a
 * revoked role or an ordinary policy denial, which is a false recovery
 * instruction. Fresh authentication applies only to broad changes, and only the
 * database knows whether that predicate fired.
 */
export function presentFailure(error: unknown): PresentedFailure {
  if (!(error instanceof ApiError))
    return {
      kind: 'plain',
      title: null,
      body: translate('error.unavailable.body'),
      offerReload: false,
    };
  switch (error.failure) {
    case 'conflict':
      return {
        kind: 'conflict',
        title: translate('error.conflict.title'),
        body: translate('error.conflict.body'),
        offerReload: true,
      };
    case 'fresh-authentication-required':
      return {
        kind: 'fresh-oidc',
        title: translate('error.freshSignIn.title'),
        body: translate('error.freshSignIn.body'),
        offerReload: false,
      };
    case 'denied':
      return {
        kind: 'denied',
        title: translate('error.denied.title'),
        body: translate('error.denied.body'),
        offerReload: false,
      };
    case 'invalid':
      return {
        kind: 'plain',
        title: null,
        body: translate('error.invalid.body'),
        offerReload: false,
      };
    case 'offline':
      return {
        /* Named so a surface can offer retry-when-connected rather than a generic
           failure: the request may well succeed unchanged once the link returns. */
        kind: 'offline',
        title: translate('app.offline.title'),
        body: translate('app.offline.body'),
        offerReload: false,
      };
    case 'unauthenticated':
      return {
        kind: 'session-ended',
        title: translate('error.expired.title'),
        body: translate('error.expired.body'),
        offerReload: false,
      };
    case 'not-found':
      return {
        kind: 'plain',
        title: translate('error.notFound.title'),
        body: translate('error.notFound.body'),
        offerReload: false,
      };
    case 'rate-limited':
      return { kind: 'plain', title: null, body: translate('otp.paused'), offerReload: false };
    case 'unavailable':
      return {
        kind: 'plain',
        title: translate('error.unavailable.title'),
        body: translate('error.unavailable.body'),
        offerReload: false,
      };
  }
}
