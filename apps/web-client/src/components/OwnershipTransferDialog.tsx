import { Dialog } from '@base-ui/react/dialog';
import { useEffect, useId, useRef, useState } from 'react';
import type { OwnershipTransferImpact, ProvisionedMember } from '../api/client.ts';
import { translate } from '../i18n/translate.ts';
import { confirmationMatches } from '../workspace/administration.ts';
import type { PresentedFailure } from '../workspace/failures.ts';
import { OwnershipTransferPreview } from './OwnershipTransferPreview.tsx';

export interface OwnershipTransferDialogProps {
  readonly open: boolean;
  readonly subject: ProvisionedMember | null;
  readonly impact: OwnershipTransferImpact | null;
  readonly loading: boolean;
  readonly pending: boolean;
  readonly failure: PresentedFailure | null;
  readonly onConfirm: (confirmation: string) => void;
  readonly onCancel: () => void;
}

export function OwnershipTransferDialog({
  open,
  subject,
  impact,
  loading,
  pending,
  failure,
  onConfirm,
  onCancel,
}: OwnershipTransferDialogProps): React.ReactElement {
  const titleId = useId();
  const consequenceId = useId();
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const [typed, setTyped] = useState('');

  const matches = confirmationMatches(typed, impact?.confirmation ?? null);

  useEffect(() => {
    if (open) return;
    setTyped('');
  }, [open]);

  return (
    <Dialog.Root
      open={open}
      disablePointerDismissal={pending}
      onOpenChange={(next, eventDetails) => {
        if (!next && pending) {
          eventDetails.cancel();
          return;
        }
        if (!next) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="df-modal__backdrop" />
        <Dialog.Viewport className="df-modal">
          <Dialog.Popup
            className="df-modal__panel"
            initialFocus={closeButton}
            aria-describedby={impact === null ? undefined : consequenceId}
          >
            <Dialog.Title className="df-modal__title" id={titleId}>
              {translate('members.transfer.title')}
            </Dialog.Title>

            <OwnershipTransferPreview
              impact={impact}
              loading={loading}
              pending={pending}
              failure={failure}
              typed={typed}
              describedById={consequenceId}
              onTypedChange={setTyped}
            />

            <div className="df-modal__actions">
              <Dialog.Close className="df-button" ref={closeButton} disabled={pending}>
                {translate('structure.cancel')}
              </Dialog.Close>
              {impact === null || loading ? null : (
                <button
                  type="button"
                  className="df-button df-button--primary"
                  data-busy={pending ? 'true' : 'false'}
                  disabled={pending || !matches || subject === null}
                  onClick={() => {
                    if (matches) onConfirm(typed);
                  }}
                >
                  {pending
                    ? translate('members.transfer.pending')
                    : translate('members.transfer.submit')}
                </button>
              )}
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
