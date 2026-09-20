/**
 * The publication preview and typed confirmation.
 *
 * This dialog is the member's only defence against publishing something they did
 * not intend, so it is a legible per-item change list rather than a raw diff: each
 * row names the path and states in words what viewers will experience. The change
 * kinds come from the server's dry-run, which shares one definition with the apply
 * path, so this preview cannot understate what publishing will do.
 *
 * The confirmation phrase is the SERVER's string, echoed back verbatim and compared
 * server-side. The client cannot synthesize it, and a caller that skips the preview
 * cannot guess it.
 *
 * Nothing is published until the phrase matches and the member submits. The empty
 * case says plainly that there is nothing to publish rather than offering a button
 * that would do nothing.
 */

import { Dialog } from '@base-ui/react/dialog';
import { useEffect, useId, useRef, useState } from 'react';
import { translate, type MessageKey } from '../i18n/translate.ts';
import type { PublicationChangeKind, PublicationImpact } from '../api/client.ts';
import { Notice } from './Notice.tsx';

const CHANGE_LABEL: Readonly<Record<PublicationChangeKind, MessageKey>> = {
  add: 'workspace.change.add',
  remove: 'workspace.change.remove',
  rename: 'workspace.change.rename',
  move: 'workspace.change.move',
  reorder: 'workspace.change.reorder',
  description: 'workspace.change.description',
  version: 'workspace.change.version',
  replace: 'workspace.change.replace',
};

export interface PublicationDialogProps {
  readonly open: boolean;
  readonly impact: PublicationImpact | null;
  readonly loading: boolean;
  readonly pending: boolean;
  readonly failure: string | null;
  readonly onConfirm: (confirmation: string) => void;
  readonly onCancel: () => void;
}

export function PublicationDialog({
  open,
  impact,
  loading,
  pending,
  failure,
  onConfirm,
  onCancel,
}: PublicationDialogProps): React.ReactElement {
  const titleId = useId();
  const confirmId = useId();
  const [typed, setTyped] = useState('');
  const [attempted, setAttempted] = useState(false);
  const closeButton = useRef<HTMLButtonElement | null>(null);

  const matches = impact !== null && typed.trim() === impact.confirmation;

  useEffect(() => {
    if (open) return;
    setTyped('');
    setAttempted(false);
  }, [open]);

  return (
    <Dialog.Root
      open={open}
      disablePointerDismissal={pending}
      onOpenChange={(open, eventDetails) => {
        if (!open && pending) {
          eventDetails.cancel();
          return;
        }
        if (!open) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="df-modal__backdrop" />
        <Dialog.Viewport className="df-modal">
          <Dialog.Popup className="df-modal__panel" initialFocus={closeButton}>
            <Dialog.Title className="df-modal__title" id={titleId}>
              {translate('publish.preview.title')}
            </Dialog.Title>

            {loading ? (
              <p className="df-field__help">{translate('publish.preview.loading')}</p>
            ) : null}

            {failure === null ? null : (
              <Notice tone="problem" role="alert">
                {failure}
              </Notice>
            )}

            {impact === null || loading ? null : impact.affectedCount === 0 ? (
              <p className="df-field__help">{translate('publish.preview.none')}</p>
            ) : (
              <>
                <p className="df-modal__lead">{translate('publish.preview.explain')}</p>
                <p className="df-field__help" data-numeric="true">
                  {translate('publish.preview.count', { count: impact.affectedCount })}
                </p>
                <table className="df-register df-register--compact">
                  <caption className="df-visually-hidden">
                    {translate('publish.preview.title')}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">{translate('publish.preview.itemPath')}</th>
                      <th scope="col">{translate('publish.preview.itemChanges')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {impact.items.map((item) => (
                      <tr key={item.entryId}>
                        <th scope="row" className="df-register__name">
                          {item.path}
                        </th>
                        <td>
                          <ul className="df-changes">
                            {item.changes.map((change) => (
                              <li key={change}>{translate(CHANGE_LABEL[change])}</li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <div className="df-field">
                  <label className="df-field__label" htmlFor={confirmId}>
                    {translate('publish.confirm.label', { phrase: impact.confirmation })}
                  </label>
                  <input
                    id={confirmId}
                    className="df-field__input"
                    type="text"
                    value={typed}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={pending}
                    aria-invalid={attempted && !matches ? 'true' : undefined}
                    aria-describedby={attempted && !matches ? `${confirmId}-error` : undefined}
                    onChange={(event) => {
                      setTyped(event.target.value);
                    }}
                  />
                  {attempted && !matches ? (
                    <p className="df-field__error" id={`${confirmId}-error`} role="alert">
                      {translate('publish.confirm.mismatch')}
                    </p>
                  ) : null}
                </div>
              </>
            )}

            <div className="df-modal__actions">
              <Dialog.Close className="df-button" ref={closeButton} disabled={pending}>
                {translate('structure.cancel')}
              </Dialog.Close>
              {impact !== null && impact.affectedCount > 0 ? (
                <button
                  type="button"
                  className="df-button df-button--primary"
                  data-busy={pending ? 'true' : 'false'}
                  disabled={pending}
                  onClick={() => {
                    setAttempted(true);
                    if (matches) onConfirm(typed.trim());
                  }}
                >
                  {pending ? translate('publish.pending') : translate('publish.confirm.submit')}
                </button>
              ) : null}
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
