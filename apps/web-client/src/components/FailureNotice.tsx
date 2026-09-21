/**
 * A presented failure and the one recovery its class earns: sign in again when the
 * session cannot succeed, reload when a revision went stale, nothing for a denial.
 */
import { translate } from '../i18n/translate.ts';
import { OIDC_BEGIN_PATH } from '../api/client.ts';
import type { PresentedFailure } from '../workspace/failures.ts';
import { Notice } from './Notice.tsx';

export function FailureNotice({
  failure,
  onReload,
}: {
  readonly failure: PresentedFailure;
  readonly onReload?: () => void;
}): React.ReactElement {
  const signIn = failure.kind === 'fresh-oidc' || failure.kind === 'session-ended';
  return (
    <Notice
      tone="problem"
      role="alert"
      {...(failure.title === null ? {} : { title: failure.title })}
    >
      <p>{failure.body}</p>
      {signIn ? (
        <a className="df-button" href={OIDC_BEGIN_PATH}>
          {translate('failure.signInAgain')}
        </a>
      ) : null}
      {failure.offerReload && onReload !== undefined ? (
        <button type="button" className="df-button" onClick={onReload}>
          {translate('failure.reload')}
        </button>
      ) : null}
    </Notice>
  );
}
