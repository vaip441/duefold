/**
 * The Access section: readers and their grants, then counterparties. Composed here so
 * neither panel grows the other, and so the room view renders one element.
 */
import type { ReactElement } from 'react';
import type { MemberRoom, WorkingEntry } from '../../api/client.ts';
import { CounterpartyControls } from '../../components/CounterpartyControls.tsx';
import { ParticipantsPanel } from '../../components/ParticipantsPanel.tsx';
import type { ParticipantsSection } from '../useParticipantsSection.ts';

export interface AccessSectionProps {
  readonly roomId: string;
  readonly room: MemberRoom | null;
  readonly entries: readonly WorkingEntry[];
  readonly section: ParticipantsSection;
  readonly onStatus: (message: string) => void;
  readonly onRoomsChanged: () => void;
}

export function AccessSection({
  roomId,
  room,
  entries,
  section,
  onStatus,
  onRoomsChanged,
}: AccessSectionProps): ReactElement {
  const roster = section.roster;
  return (
    <>
      <ParticipantsPanel
        participants={roster.kind === 'ready' ? roster.value.participants : []}
        entries={entries}
        loading={roster.kind === 'loading'}
        denied={roster.kind === 'failed'}
        failure={section.failure}
        inviteFailure={section.inviteFailure}
        invitePending={section.invitePending}
        roomIsDraft={room?.state === 'draft'}
        impact={section.impact}
        impactLoading={section.impactPending}
        applyPending={section.applyPending}
        changeFailure={section.changeFailure}
        onInvite={(email) => {
          if (room === null) return;
          section.invite({ roomId, email, expectedRoomRevision: room.revision });
        }}
        onReview={(submission) => {
          section.review(roomId, submission);
        }}
        onApply={(confirmation) => {
          if (room === null) return;
          section.apply({ roomId, expectedRoomRevision: room.revision, confirmation });
        }}
        onCancelChange={section.cancelChange}
        onReload={() => {
          section.beginLoading();
          section.refresh(roomId);
          onRoomsChanged();
        }}
      />
      {roster.kind === 'ready' && room !== null ? (
        <CounterpartyControls
          roomId={roomId}
          roomRevision={room.revision}
          roster={roster.value}
          entries={entries}
          section={section}
          onStatus={onStatus}
        />
      ) : null}
    </>
  );
}
