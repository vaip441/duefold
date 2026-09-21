/**
 * One dialog for every reviewed or typed confirmation in room administration.
 *
 * The consequence is stated before the field that unlocks the action (§6.3). A phrase,
 * when the change has one, is the server's: compared exactly and submitted exactly as
 * typed. A change without one still states its consequence and takes one deliberate press.
 *
 * The dialog owns its pending and failure state: it closes when `confirm` resolves null
 * and otherwise stays open showing the refusal. Dismissal is suppressed while a change is
 * in flight so its outcome is never lost. Cancel takes initial focus.
 */
import { Dialog } from '@base-ui/react/dialog';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { translate } from '../i18n/translate.ts';
import type { PresentedFailure } from '../workspace/failures.ts';
import { FailureNotice } from './FailureNotice.tsx';

export type Confirmation =
  | {
      readonly phrase: string;
      readonly confirm: (typed: string) => Promise<PresentedFailure | null>;
    }
  | { readonly phrase: null; readonly confirm: () => Promise<PresentedFailure | null> };

export type ConfirmationContent =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly failure: PresentedFailure }
  | {
      readonly kind: 'ready';
      readonly consequence: ReactNode;
      readonly confirmation: Confirmation;
    };

export interface ConfirmationBodyProps {
  readonly content: ConfirmationContent;
  readonly consequenceId: string;
  readonly typed: string;
  readonly pending: boolean;
  readonly failure: PresentedFailure | null;
  readonly onTypedChange: (value: string) => void;
  readonly onReload: () => void;
}

export function ConfirmationBody({
  content,
  consequenceId,
  typed,
  pending,
  failure,
  onTypedChange,
  onReload,
}: ConfirmationBodyProps): React.ReactElement {
  const fieldId = useId();
  if (content.kind === 'loading')
    return (
      <p className="df-field__help" role="status">
        {translate('confirm.loading')}
      </p>
    );
  if (content.kind === 'failed')
    return <FailureNotice failure={content.failure} onReload={onReload} />;
  const { phrase } = content.confirmation;
  /* Said once the person has started typing, not on an empty field: an error beside a field
     nobody has touched is noise. A disabled submit alone would leave a keyboard or
     screen-reader user at a dead control with no stated reason. */
  const mismatch = phrase !== null && typed !== '' && typed !== phrase;
  return (
    <>
      <div id={consequenceId}>{content.consequence}</div>
      {phrase === null ? null : (
        <div className="df-field">
          <label className="df-field__label" htmlFor={fieldId}>
            {translate('confirm.typeToConfirm', { phrase })}
          </label>
          <input
            id={fieldId}
            className="df-field__input"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            disabled={pending}
            aria-invalid={mismatch ? 'true' : undefined}
            aria-describedby={mismatch ? `${fieldId}-error` : undefined}
            onChange={(event) => {
              onTypedChange(event.target.value);
            }}
          />
          {mismatch ? (
            <p className="df-field__error" id={`${fieldId}-error`} role="alert">
              {translate('confirm.mismatch')}
            </p>
          ) : null}
        </div>
      )}
      {failure === null ? null : <FailureNotice failure={failure} onReload={onReload} />}
    </>
  );
}

export interface ConfirmationDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly submitLabel: string;
  readonly pendingLabel: string;
  readonly content: ConfirmationContent;
  readonly onClose: () => void;
  readonly onReload: () => void;
}

export function isConfirmationUnlocked(confirmation: Confirmation, typed: string): boolean {
  return confirmation.phrase === null || typed === confirmation.phrase;
}

/**
 * Whether the primary action may be pressed: never while a press is in flight, and for a
 * typed confirmation only once the phrase matches exactly. The dialog reads its disabled
 * state from here so the gate cannot be bypassed by rendering the button differently.
 */
export function submitEnabled(
  confirmation: Confirmation | null,
  typed: string,
  pending: boolean,
): boolean {
  if (pending || confirmation === null) return false;
  return isConfirmationUnlocked(confirmation, typed);
}

export function ConfirmationDialog({
  open,
  title,
  submitLabel,
  pendingLabel,
  content,
  onClose,
  onReload,
}: ConfirmationDialogProps): React.ReactElement {
  const consequenceId = useId();
  const cancel = useRef<HTMLButtonElement | null>(null);
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<PresentedFailure | null>(null);

  useEffect(() => {
    if (open) return;
    setTyped('');
    setFailure(null);
  }, [open]);

  const run = async (confirmation: Confirmation): Promise<void> => {
    setPending(true);
    setFailure(null);
    const refused = await (confirmation.phrase === null
      ? confirmation.confirm()
      : confirmation.confirm(typed));
    setPending(false);
    if (refused === null) onClose();
    else setFailure(refused);
  };

  const ready = content.kind === 'ready' ? content.confirmation : null;
  const unlocked = submitEnabled(ready, typed, pending);

  return (
    <Dialog.Root
      open={open}
      disablePointerDismissal={pending}
      onOpenChange={(next, eventDetails) => {
        if (!next && pending) {
          eventDetails.cancel();
          return;
        }
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="df-modal__backdrop" />
        <Dialog.Viewport className="df-modal">
          <Dialog.Popup
            className="df-modal__panel"
            initialFocus={cancel}
            aria-describedby={ready === null ? undefined : consequenceId}
          >
            <Dialog.Title className="df-modal__title">{title}</Dialog.Title>
            <ConfirmationBody
              content={content}
              consequenceId={consequenceId}
              typed={typed}
              pending={pending}
              failure={failure}
              onTypedChange={setTyped}
              onReload={onReload}
            />
            <div className="df-modal__actions">
              <Dialog.Close className="df-button" ref={cancel} disabled={pending}>
                {translate('structure.cancel')}
              </Dialog.Close>
              {ready === null ? null : (
                <button
                  type="button"
                  className="df-button df-button--primary"
                  data-busy={pending ? 'true' : 'false'}
                  disabled={!unlocked}
                  onClick={() => {
                    void run(ready);
                  }}
                >
                  {pending ? pendingLabel : submitLabel}
                </button>
              )}
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
