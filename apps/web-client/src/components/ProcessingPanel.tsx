/**
 * Files being checked, and what a member can do about a failure.
 *
 * The honesty constraints here matter more than the layout:
 *
 * - QUARANTINE IS NAMED AS ISOLATION, not as a vague "processing". A member needs
 *   to understand that the file is held apart from the room until it is cleared.
 * - MALWARE IS STATED PLAINLY and the file cannot be published or downloaded.
 * - RETRY IS OFFERED ONCE, because the server permits exactly one manual retry.
 *   The availability comes from the state and retry count the SERVER reported, not
 *   from a local guess, so the control is never present when the server would
 *   refuse it.
 * - DELETION IS IRREVERSIBLE and says so BEFORE the control, with a typed
 *   confirmation. No countdown: the server owns when the deletion is real.
 *
 * Nothing here renders an original filename, object key, digest, or raw state
 * identifier: the contract does not return the first three, and the fourth is
 * internal vocabulary.
 */

import { useId, useState } from 'react';
import type { ProcessingVersion } from '../api/client.ts';
import { translate } from '../i18n/translate.ts';
import { presentProcessing } from '../workspace/state.ts';
import { formatDate } from '../workspace/grants.ts';
import type { PresentedFailure } from '../workspace/failures.ts';
import { Notice } from './Notice.tsx';

export interface ProcessingPanelProps {
  readonly versions: readonly ProcessingVersion[];
  readonly loading: boolean;
  /* True when the load FAILED. The empty state must not stand in for a refusal:
     telling an operator "nothing is here" when the data was denied represents
     inaccessible content as absent. */
  readonly denied: boolean;
  readonly failure: PresentedFailure | null;
  readonly busyVersionId: string | null;
  readonly onRetry: (version: ProcessingVersion) => void;
  readonly onDeleteSource: (version: ProcessingVersion) => void;
  readonly onRefresh: () => void;
  readonly onReload: () => void;
}

const DELETE_PHRASE = 'delete';

export function ProcessingPanel({
  versions,
  loading,
  denied,
  failure,
  busyVersionId,
  onRetry,
  onDeleteSource,
  onRefresh,
  onReload,
}: ProcessingPanelProps): React.ReactElement {
  const headingId = useId();
  const confirmId = useId();
  const [deleting, setDeleting] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [attempted, setAttempted] = useState(false);

  return (
    <section aria-labelledby={headingId}>
      <h2 className="df-section__heading" id={headingId}>
        {translate('processing.heading')}
      </h2>

      {failure === null ? null : (
        <Notice
          tone="problem"
          role="alert"
          {...(failure.title === null ? {} : { title: failure.title })}
        >
          {failure.body}{' '}
          {failure.offerReload ? (
            <button type="button" className="df-textlink" onClick={onReload}>
              {translate('error.conflict.reload')}
            </button>
          ) : null}
        </Notice>
      )}

      {loading ? (
        <p className="df-field__help">{translate('processing.loading')}</p>
      ) : denied ? null : versions.length === 0 ? (
        <div className="df-empty">
          <span className="df-empty__lead">{translate('processing.empty')}</span>
          {translate('processing.emptyHelp')}
        </div>
      ) : (
        <table className="df-register">
          <caption className="df-visually-hidden">{translate('processing.heading')}</caption>
          <thead>
            <tr>
              <th scope="col">{translate('processing.columns.document')}</th>
              <th scope="col">{translate('processing.columns.state')}</th>
              <th scope="col">{translate('processing.columns.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((version) => {
              const presented = presentProcessing(version);
              const busy = busyVersionId === version.versionId;
              return (
                <tr key={version.versionId} data-processing-state={version.state}>
                  <th
                    scope="row"
                    className="df-register__name"
                    data-label={translate('processing.columns.document')}
                  >
                    {version.displayTitle}
                    {version.retainedUntil === null ? null : (
                      <span className="df-register__meta" data-numeric="true">
                        {translate('processing.retained', {
                          date: formatDate(version.retainedUntil),
                        })}
                      </span>
                    )}
                  </th>
                  <td data-label={translate('processing.columns.state')}>
                    <span className="df-state" data-tone={presented.tone}>
                      {translate(presented.label)}
                    </span>
                    {presented.help === null ? null : (
                      <span className="df-register__meta">{translate(presented.help)}</span>
                    )}
                    {presented.retryExhausted ? (
                      <span className="df-register__meta">
                        {translate('processing.retry.exhausted')}
                      </span>
                    ) : null}
                  </td>
                  <td data-label={translate('processing.columns.actions')}>
                    <div className="df-register__actions">
                      {presented.canRetry ? (
                        <button
                          type="button"
                          className="df-button"
                          data-busy={busy ? 'true' : 'false'}
                          disabled={busy}
                          onClick={() => {
                            onRetry(version);
                          }}
                        >
                          {busy
                            ? translate('processing.retry.pending')
                            : translate('processing.retry')}
                          <span className="df-visually-hidden"> {version.displayTitle}</span>
                        </button>
                      ) : null}

                      {presented.canDeleteSource ? (
                        deleting === version.versionId ? (
                          <div className="df-inline-form df-inline-form--stacked">
                            {/* The warning precedes the control, not after it. */}
                            <Notice tone="problem" role="alert">
                              {translate('processing.delete.warning')}
                            </Notice>
                            <div className="df-field">
                              <label className="df-field__label" htmlFor={confirmId}>
                                {translate('processing.delete.confirmLabel', {
                                  phrase: DELETE_PHRASE,
                                })}
                              </label>
                              <input
                                id={confirmId}
                                className="df-field__input"
                                type="text"
                                autoComplete="off"
                                spellCheck={false}
                                value={typed}
                                disabled={busy}
                                aria-invalid={
                                  attempted && typed.trim() !== DELETE_PHRASE
                                    ? 'true'
                                    : undefined
                                }
                                onChange={(event) => {
                                  setTyped(event.target.value);
                                }}
                              />
                              {attempted && typed.trim() !== DELETE_PHRASE ? (
                                <p className="df-field__error" role="alert">
                                  {translate('grant.confirm.mismatch')}
                                </p>
                              ) : null}
                            </div>
                            <button
                              type="button"
                              className="df-button df-button--primary"
                              data-busy={busy ? 'true' : 'false'}
                              disabled={busy}
                              onClick={() => {
                                setAttempted(true);
                                if (typed.trim() !== DELETE_PHRASE) return;
                                onDeleteSource(version);
                                setDeleting(null);
                                setTyped('');
                                setAttempted(false);
                              }}
                            >
                              {busy
                                ? translate('processing.delete.pending')
                                : translate('processing.delete.confirm')}
                            </button>
                            <button
                              type="button"
                              className="df-button df-button--quiet"
                              disabled={busy}
                              onClick={() => {
                                setDeleting(null);
                                setTyped('');
                                setAttempted(false);
                              }}
                            >
                              {translate('structure.cancel')}
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="df-button df-button--quiet"
                            disabled={busy}
                            onClick={() => {
                              setDeleting(version.versionId);
                              setTyped('');
                              setAttempted(false);
                            }}
                          >
                            {translate('processing.delete')}
                            <span className="df-visually-hidden"> {version.displayTitle}</span>
                          </button>
                        )
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <p className="df-field__help">{translate('processing.retry.once')}</p>
      <button type="button" className="df-button df-button--quiet" onClick={onRefresh}>
        {translate('processing.refresh')}
      </button>
    </section>
  );
}
