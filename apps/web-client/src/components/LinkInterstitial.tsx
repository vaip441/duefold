/**
 * The safe-link interstitial.
 *
 * A viewer never navigates straight out of a document. This dialog shows the
 * NORMALIZED destination domain the server resolved -- not the raw href from the
 * document -- and states plainly that they are leaving Duefold. Showing the
 * server's normalization is the whole point: a link whose visible text claims one
 * domain while its target is another cannot mislead here, because the domain
 * displayed is the one the server parsed.
 *
 * The outbound anchor carries `rel="noopener noreferrer"`, and the click is not
 * tracked: external link clicks are not engagement-tracked, so there is
 * no beacon, no logging call, and no interception of the navigation.
 */

import { useEffect, useId, useRef } from 'react';
import { translate } from '../i18n/translate.ts';
import type { InterstitialTarget } from '../api/client.ts';
import { Notice } from './Notice.tsx';

export interface LinkInterstitialProps {
  readonly target: InterstitialTarget | null;
  readonly loading: boolean;
  readonly failure: string | null;
  readonly onCancel: () => void;
}

export function LinkInterstitial({
  target,
  loading,
  failure,
  onCancel,
}: LinkInterstitialProps): React.ReactElement {
  const titleId = useId();
  const cancelButton = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    cancelButton.current?.focus();
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onCancel]);

  return (
    <div className="df-modal" role="presentation">
      <div
        className="df-modal__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h2 className="df-modal__title" id={titleId}>
          {translate('viewer.link.leaving')}
        </h2>

        {loading ? (
          <p className="df-field__help">{translate('viewer.link.resolving')}</p>
        ) : null}

        {failure === null ? null : (
          <Notice tone="problem" role="alert">
            {failure}
          </Notice>
        )}

        {target === null || loading ? null : (
          <>
            <p className="df-modal__lead">{target.warning}</p>
            <p className="df-field__label">{translate('viewer.link.destination')}</p>
            {/* The normalized domain is the security-bearing fact, so it is the
                most prominent thing in the dialog. */}
            <p className="df-interstitial__domain">{target.normalizedDomain}</p>
          </>
        )}

        <div className="df-modal__actions">
          <button type="button" className="df-button" ref={cancelButton} onClick={onCancel}>
            {translate('viewer.link.cancel')}
          </button>
          {target === null || loading ? null : (
            <a
              className="df-button df-button--primary"
              href={target.destination}
              target="_blank"
              rel="noopener noreferrer"
              onClick={onCancel}
            >
              {translate('viewer.link.continue')}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
