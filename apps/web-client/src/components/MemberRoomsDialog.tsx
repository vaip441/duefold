/**
 * The room-assignment dialog.
 *
 * A focus shell around `MemberRoomsForm`, which carries the sign-out warning and the
 * per-room controls. Base UI owns focus trapping and return, Escape and outside
 * dismissal, and the exit transition; dismissal is suppressed while the batch is in
 * flight, because closing mid-request would leave the administrator without a report
 * of a change that signs someone out.
 *
 * The submit stays disabled until the draft differs from what the member holds: a
 * batch that changes nothing still revokes their sessions.
 */

import { Dialog } from '@base-ui/react/dialog';
import { useEffect, useId, useRef, useState } from 'react';
import type { MemberRoom, ProvisionedMember, RoomAssignment } from '../api/client.ts';
import { translate } from '../i18n/translate.ts';
import {
  assignmentBatch,
  batchChangesSomething,
  heldRoles,
  type AssignmentDraft,
} from '../workspace/administration.ts';
import type { PresentedFailure } from '../workspace/failures.ts';
import { MemberRoomsForm } from './MemberRoomsForm.tsx';

export interface MemberRoomsDialogProps {
  readonly open: boolean;
  /**
   * Null while closed, so the dialog holds no stale person. A PROVISIONED member: an
   * invitation has no member row, so nothing could hold a room assignment against it.
   */
  readonly subject: ProvisionedMember | null;
  readonly rooms: readonly MemberRoom[];
  /**
   * Whether `rooms` is the WHOLE register.
   *
   * The register is paged (§23). When it stopped short, "Not staffed" is an answer about
   * the rooms shown and nothing more, so the form says that instead of letting a room it
   * never received read as one this member is not in. The diff already leaves unseen
   * rooms untouched; this makes that visible rather than merely true.
   */
  readonly roomsComplete: boolean;
  /** True while a further page of the register is being read. */
  readonly roomsLoadingMore: boolean;
  /**
   * Reads the next page of the register.
   *
   * Offered INSIDE the dialog, because this is where the incomplete list is acted on. A
   * caveat with no way to resolve it left the administrator to decide staffing from a
   * prefix; now the rest is one bounded request away without leaving the draft.
   */
  readonly onLoadMoreRooms: () => void;
  readonly pending: boolean;
  /**
   * The failure of the last submitted batch, or null.
   *
   * Rendered INSIDE the dialog with the draft intact. Closing on submit and reporting
   * the failure behind the table would have discarded the administrator's choices and
   * asked them to reconstruct a multi-room batch from memory.
   */
  readonly failure: PresentedFailure | null;
  readonly onApply: (input: {
    readonly memberId: string;
    readonly assign: readonly RoomAssignment[];
    readonly revoke: readonly string[];
  }) => void;
  readonly onClose: () => void;
}

export function MemberRoomsDialog({
  open,
  subject,
  rooms,
  roomsComplete,
  roomsLoadingMore,
  onLoadMoreRooms,
  pending,
  failure,
  onApply,
  onClose,
}: MemberRoomsDialogProps): React.ReactElement {
  const titleId = useId();
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const [draft, setDraft] = useState<AssignmentDraft>({});

  /*
   * Seeded from the member's CURRENT set every time the dialog opens, so it never
   * carries a previous person's draft or a set the server has since changed.
   */
  useEffect(() => {
    if (open) setDraft(heldRoles(subject));
  }, [open, subject]);

  const batch = assignmentBatch({ rooms, held: heldRoles(subject), draft });
  const changed = batchChangesSomething(batch);

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
          <Dialog.Popup className="df-modal__panel" initialFocus={closeButton}>
            <Dialog.Title className="df-modal__title" id={titleId}>
              {translate('members.assign.title', { person: subject?.emailDisplay ?? '' })}
            </Dialog.Title>

            <MemberRoomsForm
              rooms={rooms}
              roomsComplete={roomsComplete}
              roomsLoadingMore={roomsLoadingMore}
              onLoadMoreRooms={onLoadMoreRooms}
              draft={draft}
              pending={pending}
              changed={changed}
              failure={failure}
              onDraftChange={(roomId, role) => {
                setDraft((current) => ({ ...current, [roomId]: role }));
              }}
            />

            <div className="df-modal__actions">
              <Dialog.Close className="df-button" ref={closeButton} disabled={pending}>
                {translate('structure.cancel')}
              </Dialog.Close>
              <button
                type="button"
                className="df-button df-button--primary"
                data-busy={pending ? 'true' : 'false'}
                disabled={pending || !changed || subject === null}
                onClick={() => {
                  if (subject === null || !changed) return;
                  onApply({ memberId: subject.subjectId, ...batch });
                }}
              >
                {pending
                  ? translate('members.assign.pending')
                  : translate('members.assign.submit')}
              </button>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
