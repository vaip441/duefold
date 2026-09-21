/**
 * Create a room.
 *
 * The room starts in draft, and the dialog says so before the action: nothing in it is
 * visible to viewers until a Room Manager publishes it. The dialog owns its pending and
 * failure state, closes when creation commits, and cannot be dismissed while a creation
 * is in flight.
 */
import { Dialog } from '@base-ui/react/dialog';
import { useEffect, useId, useRef, useState } from 'react';
import type { NewRoom } from '../api/client.ts';
import { translate } from '../i18n/translate.ts';
import type { PresentedFailure } from '../workspace/failures.ts';
import { FailureNotice } from './FailureNotice.tsx';

/** A blank title is not submittable; every other rule is the server's. */
export function canSubmitRoomTitle(title: string): boolean {
  return title.trim() !== '';
}

export interface NewRoomFormProps {
  readonly formId: string;
  readonly title: string;
  readonly description: string;
  readonly pending: boolean;
  readonly failure: PresentedFailure | null;
  readonly firstField?: React.Ref<HTMLInputElement>;
  readonly onTitleChange: (value: string) => void;
  readonly onDescriptionChange: (value: string) => void;
  readonly onSubmit: () => void;
}

export function NewRoomForm({
  formId,
  title,
  description,
  pending,
  failure,
  firstField,
  onTitleChange,
  onDescriptionChange,
  onSubmit,
}: NewRoomFormProps): React.ReactElement {
  const titleField = useId();
  const descriptionField = useId();
  const descriptionHelp = useId();
  return (
    <form
      id={formId}
      className="df-inline-form df-inline-form--stacked"
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending && canSubmitRoomTitle(title)) onSubmit();
      }}
    >
      <p className="df-field__help">{translate('rooms.new.explain')}</p>
      <div className="df-field">
        <label className="df-field__label" htmlFor={titleField}>
          {translate('rooms.new.titleLabel')}
        </label>
        <input
          id={titleField}
          ref={firstField}
          className="df-field__input"
          required
          maxLength={200}
          value={title}
          disabled={pending}
          onChange={(event) => {
            onTitleChange(event.target.value);
          }}
        />
      </div>
      <div className="df-field">
        <label className="df-field__label" htmlFor={descriptionField}>
          {translate('rooms.new.descriptionLabel')}
        </label>
        <textarea
          id={descriptionField}
          className="df-field__input"
          maxLength={4000}
          aria-describedby={descriptionHelp}
          value={description}
          disabled={pending}
          onChange={(event) => {
            onDescriptionChange(event.target.value);
          }}
        />
        <p id={descriptionHelp} className="df-field__help">
          {translate('rooms.new.descriptionHelp')}
        </p>
      </div>
      {failure === null ? null : <FailureNotice failure={failure} />}
    </form>
  );
}

export interface NewRoomDialogProps {
  readonly open: boolean;
  readonly onCreate: (room: NewRoom) => Promise<PresentedFailure | null>;
  readonly onClose: () => void;
}

export function NewRoomDialog({
  open,
  onCreate,
  onClose,
}: NewRoomDialogProps): React.ReactElement {
  const formId = useId();
  const firstField = useRef<HTMLInputElement | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<PresentedFailure | null>(null);

  useEffect(() => {
    if (open) return;
    setTitle('');
    setDescription('');
    setFailure(null);
  }, [open]);

  const submit = async (): Promise<void> => {
    setPending(true);
    setFailure(null);
    const refused = await onCreate({ title, description });
    setPending(false);
    if (refused === null) onClose();
    else setFailure(refused);
  };

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
          <Dialog.Popup className="df-modal__panel" initialFocus={firstField}>
            <Dialog.Title className="df-modal__title">
              {translate('rooms.new.title')}
            </Dialog.Title>
            <NewRoomForm
              formId={formId}
              title={title}
              description={description}
              pending={pending}
              failure={failure}
              firstField={firstField}
              onTitleChange={setTitle}
              onDescriptionChange={setDescription}
              onSubmit={() => {
                void submit();
              }}
            />
            <div className="df-modal__actions">
              <Dialog.Close className="df-button" disabled={pending}>
                {translate('structure.cancel')}
              </Dialog.Close>
              <button
                type="submit"
                form={formId}
                className="df-button df-button--primary"
                data-busy={pending ? 'true' : 'false'}
                disabled={pending || !canSubmitRoomTitle(title)}
              >
                {pending ? translate('rooms.new.pending') : translate('rooms.new.submit')}
              </button>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
