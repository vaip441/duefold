/**
 * Original download panel.
 *
 * Three honest states: denied, allowed, and in progress. Under a denied policy no
 * download control is offered at all and the reason is stated -- but the absence of
 * the control is not the enforcement. The server refuses the lease, and this panel
 * only avoids presenting an action that would be rejected.
 *
 * The unwatermarked warning appears BEFORE the download control, not after it. A
 * viewer who has read attributed pages all session may reasonably assume the file
 * is attributed too; the policy requires saying otherwise, and saying it late would be
 * saying it after the decision.
 *
 * Progress is honest: bytes actually received over bytes the lease reported. There
 * is no synthetic animation pretending to progress, and a cancelled or failed
 * download says plainly that nothing was saved.
 */

import { useId } from 'react';
import { translate } from '../i18n/translate.ts';
import type { DownloadPolicy } from '../api/client.ts';
import { Notice } from './Notice.tsx';

export type DownloadState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'active'; readonly received: number; readonly total: number }
  | { readonly kind: 'done' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly message: string };

export interface DownloadPanelProps {
  readonly policy: DownloadPolicy;
  readonly state: DownloadState;
  readonly onStart: () => void;
  readonly onCancel: () => void;
}

export function DownloadPanel({
  policy,
  state,
  onStart,
  onCancel,
}: DownloadPanelProps): React.ReactElement {
  const headingId = useId();
  const progressId = useId();

  if (policy === 'deny')
    return (
      <section className="df-download" aria-labelledby={headingId}>
        <h2 className="df-section__heading" id={headingId}>
          {translate('viewer.download.heading')}
        </h2>
        <Notice tone="neutral" role="status">
          <strong>{translate('viewer.download.denied')}</strong>{' '}
          {translate('viewer.download.deniedHelp')}
        </Notice>
      </section>
    );

  const percent =
    state.kind === 'active' && state.total > 0
      ? Math.min(100, Math.round((state.received / state.total) * 100))
      : 0;

  return (
    <section className="df-download" aria-labelledby={headingId}>
      <h2 className="df-section__heading" id={headingId}>
        {translate('viewer.download.heading')}
      </h2>
      <p className="df-field__help">{translate('viewer.download.allowed')}</p>
      {/* Stated before the control, deliberately. */}
      <Notice tone="caution" role="status">
        {translate('viewer.download.notWatermarked')}
      </Notice>

      {state.kind === 'failed' ? (
        <Notice tone="problem" role="alert">
          {state.message}
        </Notice>
      ) : null}
      {state.kind === 'cancelled' ? (
        <Notice tone="neutral" role="status">
          {translate('viewer.download.cancelled')}
        </Notice>
      ) : null}
      {state.kind === 'done' ? (
        <Notice tone="action" role="status">
          {translate('viewer.download.done')}
        </Notice>
      ) : null}

      {state.kind === 'active' ? (
        <>
          <p className="df-field__help" id={progressId} data-numeric="true">
            {translate('viewer.download.progress').replace('{percent}', String(percent))}
          </p>
          {/*
            A real progress element rather than a decorative bar: it exposes
            value and max to assistive technology, and it reflects bytes actually
            received.
          */}
          <progress
            className="df-progress"
            value={state.received}
            max={state.total}
            aria-labelledby={progressId}
          />
          <button type="button" className="df-button" onClick={onCancel}>
            {translate('viewer.download.cancel')}
          </button>
        </>
      ) : (
        <button
          type="button"
          className="df-button df-button--primary"
          data-busy="false"
          onClick={onStart}
        >
          {translate('viewer.download.action')}
        </button>
      )}
    </section>
  );
}
