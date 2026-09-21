/**
 * The ownership-transfer dialog.
 *
 * A focus shell around `OwnershipTransferPreview`, which carries the statements that
 * matter: what the transfer does, which assignments it revokes, and the phrase that
 * unlocks it. The split is deliberate — the portal is a browser mechanism, and the
 * copy is the part a test should be able to read without one.
 *
 * Base UI owns focus trapping and return, Escape and outside dismissal, and the exit
 * transition. Dismissal is suppressed while the transfer is in flight, because closing
 * mid-request would leave the Owner with no report of an irreversible change.
 *
 * Apply carries the preview id the dry run issued. The phrase is a documented
 * constant, so the preview is what proves the Owner actually saw this impact.
 */

import { Dialog } from '@base-ui/react/dialog';
import { useEffect, useId, useRef, useState } from 'react';
import type { OwnershipTransferImpact, ProvisionedMember } from '../api/client.ts';
import { translate } from '../i18n/translate.ts';
import { confirmationMatches } from '../workspace/administration.ts';
import type { PresentedFailure } from '../workspace/failures.ts';
import { OwnershipTransferPreview } from './OwnershipTransferPreview.tsx';

export interface OwnershipTransferDialogProps {
  readonly open: boolean;
  /**
   * The successor. A PROVISIONED member: ownership cannot move to someone who has never
   * signed in, so an invitation is not representable here.
   */
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
              {/* Cancel takes initial focus: the panel opens on a destructive task,
                  so the first control should be the one that leaves it. */}
              <Dialog.Close className="df-button" ref={closeButton} disabled={pending}>
                {translate('structure.cancel')}
              </Dialog.Close>
              {impact === null || loading ? null : (
                <button
                  type="button"
                  className="df-button df-button--primary"
                  data-busy={pending ? 'true' : 'false'}
                  /* Disabled until the phrase matches exactly, so the control cannot
                     be pressed in a state where it would do nothing. The field
                     explains a near miss as it is typed. */
                  disabled={pending || !matches || subject === null}
                  onClick={() => {
                    /* The UNCHANGED input. Submitting a trimmed value would ask the
                       server's authoritative check about a different string than the
                       one that was typed, hiding a near miss instead of refusing it. */
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
