/**
 * Trash: what was removed, when it is permanently gone, and how to get it back.
 *
 * Three honesty constraints shape this surface:
 *
 * 1. Retention is FIXED at the server's value and cannot be extended or bypassed,
 *    so it is stated as a fact rather than as a setting.
 * 2. `purgeAfter` is formatted from the SERVER's absolute instant. No countdown is
 *    computed from the browser clock: a wrong "1 day left" before an irreversible
 *    purge would be a serious failure, so the date is shown as given.
 * 3. A trashed name is NOT reserved and restore does NOT return publication or
 *    viewer access. Both are stated, because a member who assumes otherwise would
 *    be wrong in a way that costs them.
 */

import { useId, useState } from 'react';
import { translate } from '../i18n/translate.ts';
import type { TrashEntry, WorkingEntry } from '../api/client.ts';

export interface TrashViewProps {
  readonly trash: readonly TrashEntry[];
  readonly retentionDays: number;
  readonly folders: readonly WorkingEntry[];
  readonly busyTrashId: string | null;
  readonly onRestore: (input: {
    readonly entry: TrashEntry;
    readonly displayName: string;
    readonly destinationFolderId: string | null;
  }) => void;
}

/** Absolute server date, rendered in the reader's locale without arithmetic. */
function formatInstant(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export function TrashView({
  trash,
  retentionDays,
  folders,
  busyTrashId,
  onRestore,
}: TrashViewProps): React.ReactElement {
  const [restoring, setRestoring] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [destination, setDestination] = useState<string>('');
  const nameId = useId();
  const destinationId = useId();

  return (
    <section aria-labelledby={`${nameId}-heading`}>
      <h2 className="df-section__heading" id={`${nameId}-heading`}>
        {translate('workspace.section.trash')}
      </h2>
      <p className="df-field__help">{translate('trash.retention', { days: retentionDays })}</p>
      <p className="df-field__help">{translate('trash.nameNotReserved')}</p>
      <p className="df-field__help">{translate('trash.restoreNote')}</p>

      {trash.length === 0 ? (
        <div className="df-empty">
          <span className="df-empty__lead">{translate('trash.empty')}</span>
        </div>
      ) : (
        <table className="df-register df-register--compact">
          <caption className="df-visually-hidden">
            {translate('workspace.section.trash')}
          </caption>
          <thead>
            <tr>
              <th scope="col">{translate('workspace.columns.name')}</th>
              <th scope="col">{translate('trash.trashedAt')}</th>
              <th scope="col">{translate('trash.purgeAfter')}</th>
              <th scope="col">{translate('workspace.columns.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {trash.map((entry) => {
              const busy = busyTrashId === entry.trashId;
              return (
                <tr key={entry.trashId}>
                  <th scope="row" className="df-register__name">
                    {entry.displayName}
                    {entry.wasPublished ? (
                      <span className="df-register__meta">
                        {translate('trash.wasPublished')}
                      </span>
                    ) : null}
                  </th>
                  <td data-numeric="true">{formatInstant(entry.trashedAt)}</td>
                  <td data-numeric="true">{formatInstant(entry.purgeAfter)}</td>
                  <td>
                    <div className="df-register__actions">
                      {restoring === entry.trashId ? (
                        <form
                          className="df-inline-form df-inline-form--stacked"
                          noValidate
                          onSubmit={(event) => {
                            event.preventDefault();
                            if (busy || name.trim() === '') return;
                            onRestore({
                              entry,
                              displayName: name.trim(),
                              destinationFolderId: destination === '' ? null : destination,
                            });
                          }}
                        >
                          <div className="df-field">
                            <label className="df-field__label" htmlFor={nameId}>
                              {translate('trash.restore.name')}
                            </label>
                            <input
                              id={nameId}
                              className="df-field__input"
                              value={name}
                              disabled={busy}
                              onChange={(event) => {
                                setName(event.target.value);
                              }}
                            />
                          </div>
                          <div className="df-field">
                            <label className="df-field__label" htmlFor={destinationId}>
                              {translate('trash.restore.destination')}
                            </label>
                            <select
                              id={destinationId}
                              className="df-field__input"
                              value={destination}
                              disabled={busy}
                              onChange={(event) => {
                                setDestination(event.target.value);
                              }}
                            >
                              <option value="">
                                {translate('structure.move.destinationRoot')}
                              </option>
                              {folders.map((folder) => (
                                <option key={folder.resourceId} value={folder.resourceId}>
                                  {folder.displayName}
                                </option>
                              ))}
                            </select>
                          </div>
                          <button
                            type="submit"
                            className="df-button df-button--primary"
                            data-busy={busy ? 'true' : 'false'}
                            disabled={busy || name.trim() === ''}
                          >
                            {busy
                              ? translate('trash.restore.pending')
                              : translate('trash.restore.submit')}
                          </button>
                          <button
                            type="button"
                            className="df-button df-button--quiet"
                            disabled={busy}
                            onClick={() => {
                              setRestoring(null);
                            }}
                          >
                            {translate('structure.cancel')}
                          </button>
                        </form>
                      ) : (
                        <button
                          type="button"
                          className="df-button"
                          onClick={() => {
                            setRestoring(entry.trashId);
                            setName(entry.displayName);
                            setDestination('');
                          }}
                        >
                          {translate('trash.restore')}
                          <span className="df-visually-hidden"> {entry.displayName}</span>
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
