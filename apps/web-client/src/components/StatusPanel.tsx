/**
 * The Status section: §20.2's read-only facts as one table, each state in words and each time
 * as a `<time>` carrying its UTC value. It owns no state.
 */
import { useId } from 'react';
import type { InstallationStatus } from '../api/client.ts';
import { translate } from '../i18n/translate.ts';
import {
  formatInstant,
  STATE_LABEL,
  statusRows,
  type RowTime,
} from '../workspace/status-rows.ts';
import type { LoadedSection } from '../workspace/useLoad.ts';
import { classifyLoad } from '../workspace/views/load-state.ts';
import { FailureNotice } from './FailureNotice.tsx';
import { Notice } from './Notice.tsx';

function When({ time }: { readonly time: RowTime }): React.ReactElement {
  if (time.kind === 'now') return <>{translate('status.now')}</>;
  if (time.kind === 'never') return <>{translate('status.never')}</>;
  return (
    <time dateTime={time.iso} title={time.iso}>
      {formatInstant(time.iso)}
    </time>
  );
}

export function StatusPanel({
  section,
}: {
  readonly section: LoadedSection<InstallationStatus>;
}): React.ReactElement {
  const headingId = useId();
  const heading = (
    <h2 id={headingId} className="df-section__heading">
      {translate('status.heading')}
    </h2>
  );
  const { load } = section;

  if (load.kind === 'loading')
    return (
      <section aria-labelledby={headingId}>
        {heading}
        <p className="df-field__help">{translate('status.loading')}</p>
      </section>
    );

  if (load.kind === 'failed') {
    const state = classifyLoad({ failed: true, failure: section.failure });
    return (
      <section aria-labelledby={headingId}>
        {heading}
        {state.denied ? (
          <Notice tone="caution" role="status">
            {translate('status.denied')}
          </Notice>
        ) : section.failure === null ? null : (
          <FailureNotice failure={section.failure} onReload={section.reload} />
        )}
        {state.recovery === 'retry' && section.failure?.offerReload !== true ? (
          <button type="button" className="df-button" onClick={section.reload}>
            {translate('app.retry')}
          </button>
        ) : null}
      </section>
    );
  }

  const rows = statusRows(load.value);
  const failing = rows.filter((row) => row.state === 'fail').length;
  const columns = {
    state: translate('status.column.state'),
    details: translate('status.column.details'),
    time: translate('status.column.time'),
  };
  return (
    <section aria-labelledby={headingId}>
      {heading}
      {failing === 0 ? null : (
        <Notice tone="problem" role="alert">
          {translate('status.summary.failing', { count: failing })}
        </Notice>
      )}
      <table className="df-register">
        <caption className="df-visually-hidden">{translate('status.caption')}</caption>
        <thead>
          <tr>
            <th scope="col">{translate('status.column.check')}</th>
            <th scope="col">{columns.state}</th>
            <th scope="col">{columns.details}</th>
            <th scope="col">{columns.time}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} data-status={row.state}>
              <th scope="row" className="df-register__name">
                {translate(row.label)}
              </th>
              <td data-label={columns.state}>
                <span className="df-state" data-live={row.state === 'pass' ? 'true' : 'false'}>
                  {translate(STATE_LABEL[row.state])}
                </span>
              </td>
              <td data-label={columns.details}>
                {row.details.map((detail) => (
                  <span key={detail} className="df-register__meta">
                    {detail}
                  </span>
                ))}
              </td>
              <td data-label={columns.time}>
                <When time={row.time} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="df-panel__actions">
        <button type="button" className="df-button" onClick={section.reload}>
          {translate('status.refresh')}
        </button>
      </div>
    </section>
  );
}
