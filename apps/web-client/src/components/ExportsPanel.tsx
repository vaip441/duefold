/**
 * Exports: what a room can produce, and the single download it allows.
 *
 * The defining constraint is that an export can be downloaded ONCE. That fact is
 * stated before the control, not after the click and not in a toast afterwards: a
 * member who believes they can re-download will lose the file. `canDownload` also
 * accounts for the server's one-hour expiry, so the control is absent when the
 * server would refuse rather than present and failing.
 *
 * The preflight is shown BEFORE generating, because it is where a member learns
 * that originals are unwatermarked and which personal-data categories the archive
 * will contain. Its numbers are the server's.
 *
 * No object key, storage URL, or download link is rendered: the contract returns
 * none, and the download is a POST that streams the body.
 */

import { useId, useState } from 'react';
import type { ExportPreflight, ExportPreset, ExportRecord } from '../api/client.ts';
import { translate, translateCount } from '../i18n/translate.ts';
import { formatSize, presentExport } from '../workspace/state.ts';
import { formatDate } from '../workspace/grants.ts';
import type { PresentedFailure } from '../workspace/failures.ts';
import { Notice } from './Notice.tsx';

const PRESETS: readonly ExportPreset[] = [
  'room-index-audit',
  'participant-access',
  'selected-documents',
];

export interface ExportsPanelProps {
  readonly exports: readonly ExportRecord[];
  readonly loading: boolean;
  /* True when the load FAILED. The empty state must not stand in for a refusal:
     telling an operator "nothing is here" when the data was denied represents
     inaccessible content as absent. */
  readonly denied: boolean;
  readonly failure: PresentedFailure | null;
  readonly preflight: ExportPreflight | null;
  readonly preflightLoading: boolean;
  readonly generatePending: boolean;
  readonly downloadingId: string | null;
  readonly selectedDocumentIds: readonly string[];
  readonly onPreflight: (input: {
    readonly preset: ExportPreset;
    readonly includeOriginals: boolean;
  }) => void;
  readonly onGenerate: () => void;
  readonly onCancelPreflight: () => void;
  readonly onDownload: (record: ExportRecord) => void;
  readonly onReload: () => void;
}

export function ExportsPanel({
  exports,
  loading,
  denied,
  failure,
  preflight,
  preflightLoading,
  generatePending,
  downloadingId,
  selectedDocumentIds,
  onPreflight,
  onGenerate,
  onCancelPreflight,
  onDownload,
  onReload,
}: ExportsPanelProps): React.ReactElement {
  const headingId = useId();
  const fieldId = useId();
  const [preset, setPreset] = useState<ExportPreset>('room-index-audit');
  const [includeOriginals, setIncludeOriginals] = useState(false);
  const now = new Date();

  return (
    <section aria-labelledby={headingId}>
      <h2 className="df-section__heading" id={headingId}>
        {translate('exports.heading')}
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

      <p className="df-field__help">{translate('exports.expiry')}</p>

      {loading ? (
        <p className="df-field__help">{translate('exports.loading')}</p>
      ) : denied ? null : exports.length === 0 ? (
        <div className="df-empty">
          <span className="df-empty__lead">{translate('exports.empty')}</span>
          {translate('exports.emptyHelp')}
        </div>
      ) : (
        <table className="df-register">
          <caption className="df-visually-hidden">{translate('exports.heading')}</caption>
          <thead>
            <tr>
              <th scope="col">{translate('exports.columns.preset')}</th>
              <th scope="col">{translate('exports.columns.state')}</th>
              <th scope="col">{translate('exports.columns.expires')}</th>
              <th scope="col">{translate('exports.columns.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {exports.map((record) => {
              const presented = presentExport(record, now);
              const busy = downloadingId === record.exportId;
              return (
                <tr key={record.exportId} data-export-state={record.state}>
                  <th
                    scope="row"
                    className="df-register__name"
                    data-label={translate('exports.columns.preset')}
                  >
                    {translate(`exports.preset.${record.preset}`)}
                    {record.includeOriginals ? (
                      <span className="df-register__meta">
                        {translate('exports.includeOriginals')}
                      </span>
                    ) : null}
                    {record.sizeBytes === null ? null : (
                      <span className="df-register__meta" data-numeric="true">
                        {formatSize(record.sizeBytes)}
                      </span>
                    )}
                  </th>
                  <td data-label={translate('exports.columns.state')}>
                    <span
                      className="df-state"
                      data-live={presented.canDownload ? 'true' : 'false'}
                    >
                      {translate(presented.label)}
                    </span>
                    {presented.help === null ? null : (
                      <span className="df-register__meta">{translate(presented.help)}</span>
                    )}
                  </td>
                  <td data-label={translate('exports.columns.expires')} data-numeric="true">
                    {formatDate(record.expiresAt)}
                  </td>
                  <td data-label={translate('exports.columns.actions')}>
                    <div className="df-register__actions">
                      {presented.canDownload ? (
                        <>
                          {/* One-time nature stated BEFORE the control. */}
                          <Notice tone="caution">{translate('exports.oneTime')}</Notice>
                          <button
                            type="button"
                            className="df-button"
                            data-busy={busy ? 'true' : 'false'}
                            disabled={busy}
                            onClick={() => {
                              onDownload(record);
                            }}
                          >
                            {busy
                              ? translate('exports.download.pending')
                              : translate('exports.download')}
                          </button>
                        </>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div className="df-panel__block">
        <h3 className="df-panel__subheading">{translate('exports.create')}</h3>

        <div className="df-field">
          <label className="df-field__label" htmlFor={`${fieldId}-preset`}>
            {translate('exports.preset.label')}
          </label>
          <select
            id={`${fieldId}-preset`}
            className="df-field__input"
            value={preset}
            disabled={preflight !== null || generatePending}
            onChange={(event) => {
              setPreset(event.target.value as ExportPreset);
            }}
          >
            {PRESETS.map((value) => (
              <option key={value} value={value}>
                {translate(`exports.preset.${value}`)}
              </option>
            ))}
          </select>
        </div>

        <div className="df-field df-field--check">
          <label className="df-field__label" htmlFor={`${fieldId}-originals`}>
            <input
              id={`${fieldId}-originals`}
              type="checkbox"
              checked={includeOriginals}
              disabled={preflight !== null || generatePending}
              aria-describedby={`${fieldId}-originals-help`}
              onChange={(event) => {
                setIncludeOriginals(event.target.checked);
              }}
            />{' '}
            {translate('exports.originals.label')}
          </label>
          {/* Unwatermarked warning is always present, not only when checked. */}
          <p className="df-field__help" id={`${fieldId}-originals-help`}>
            {translate('exports.originals.help')}
          </p>
        </div>

        {preflightLoading ? (
          <p className="df-field__help">{translate('exports.preflight.loading')}</p>
        ) : null}

        {preflight === null || preflightLoading ? (
          <button
            type="button"
            className="df-button"
            data-busy={preflightLoading ? 'true' : 'false'}
            disabled={
              preflightLoading ||
              (preset === 'selected-documents' && selectedDocumentIds.length === 0)
            }
            onClick={() => {
              onPreflight({ preset, includeOriginals });
            }}
          >
            {translate('exports.preflight')}
          </button>
        ) : (
          <div className="df-impact">
            <h4 className="df-panel__subheading">{translate('exports.preflight.title')}</h4>
            <p className="df-field__help" data-numeric="true">
              {translateCount('exports.preflight.files', preflight.fileCount)}{' '}
              {translate('exports.preflight.size', {
                size: formatSize(preflight.estimatedSize),
              })}
            </p>
            {preflight.originalsIncluded ? (
              <Notice tone="caution">{translate('exports.originals.help')}</Notice>
            ) : null}
            {preflight.piiCategories.length === 0 ? null : (
              <>
                <h5 className="df-panel__subheading">{translate('exports.preflight.pii')}</h5>
                <ul className="df-changes">
                  {preflight.piiCategories.map((category) => (
                    <li key={category}>{category}</li>
                  ))}
                </ul>
              </>
            )}
            <p className="df-field__help">
              <strong>{translate('exports.preflight.retention')}</strong>{' '}
              {preflight.retentionEffect}
            </p>
            <Notice tone="caution">{translate('exports.oneTime')}</Notice>
            <div className="df-panel__actions">
              <button
                type="button"
                className="df-button df-button--primary"
                data-busy={generatePending ? 'true' : 'false'}
                disabled={generatePending}
                onClick={onGenerate}
              >
                {generatePending
                  ? translate('exports.preflight.pending')
                  : translate('exports.preflight.confirm')}
              </button>
              <button
                type="button"
                className="df-button"
                disabled={generatePending}
                onClick={onCancelPreflight}
              >
                {translate('structure.cancel')}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
