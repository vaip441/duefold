/**
 * Maps a server failure onto designed copy for a surface that reports one string.
 *
 * `presentFailure` is the richer form and is preferred for a panel that can offer a
 * reload or a title; this exists for the frame's single-line reports. Both live in
 * `workspace/` rather than in a component so there is one mapping, not one per
 * surface that could drift from it.
 *
 * Never surfaces server detail, an internal code, or a correlation id.
 */

import { ApiError } from '../api/client.ts';
import { translate } from '../i18n/translate.ts';

export function failureMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return translate('structure.rejected');
  switch (error.failure) {
    case 'offline':
      return translate('app.offline.body');
    case 'denied':
      return translate('error.denied.body');
    case 'fresh-authentication-required':
      return translate('error.freshSignIn.body');
    case 'not-found':
      return translate('error.notFound.body');
    case 'unauthenticated':
      return translate('error.expired.body');
    case 'rate-limited':
      return translate('otp.paused');
    case 'conflict':
      return translate('error.conflict.body');
    case 'invalid':
      return translate('error.invalid.body');
    case 'unavailable':
      return translate('error.unavailable.body');
  }
}
