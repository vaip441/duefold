import { Dialog } from '@base-ui/react/dialog';
import { useEffect, useId, useRef, useState } from 'react';
import type { MemberRoom, ProvisionedMember, RoomAssignment } from '../api/client.ts';
import { translate } from '../i18n/translate.ts';
import {
  assignmentBatch,
  batchChangesSomething,
  batchWithinLimit,
  MAX_BATCH_ENTRIES,
  heldRoles,
  type AssignmentDraft,
} from '../workspace/administration.ts';
import type { PresentedFailure } from '../workspace/failures.ts';
import { MemberRoomsForm } from './MemberRoomsForm.tsx';

export interface MemberRoomsDialogProps {
  readonly open: boolean;
  readonly subject: ProvisionedMember | null;
  readonly rooms: readonly MemberRoom[];
  readonly roomsComplete: boolean;
  readonly roomsLoadingMore: boolean;
  readonly onLoadMoreRooms: () => void;
  readonly pending: boolean;
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

  useEffect(() => {
    if (open) setDraft(heldRoles(subject));
  }, [open, subject]);

  const batch = assignmentBatch({ rooms, held: heldRoles(subject), draft });
  const changed = batchChangesSomething(batch);
  /* Refused here rather than by the server: the sum of both arrays is what
     apply_room_assignments bounds, and a draft over it is the administrator's to fix
     while it is still on screen. */
  const withinLimit = batchWithinLimit(batch);

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
              withinLimit={withinLimit}
              entryCount={batch.assign.length + batch.revoke.length}
              entryLimit={MAX_BATCH_ENTRIES}
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
                disabled={pending || !changed || !withinLimit || subject === null}
                onClick={() => {
                  if (subject === null || !changed || !withinLimit) return;
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
