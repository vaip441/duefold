/**
 * The room register: which rooms this member can reach, and why.
 *
 * The register is the frame's default surface, so a failed load enters the failed state
 * and NEVER `ready` with an empty list: rendering "no rooms yet" beside a refusal would
 * tell a member that inaccessible rooms are absent.
 *
 * A PARTIAL REGISTER OFFERS A WAY TO CONTINUE. It previously stated it was partial and
 * left it there, because the frame had walked to an arbitrary page cap and stored the
 * prefix as terminal — so beyond that point rooms were simply unreachable. The cursor is
 * kept now, so saying the list is partial comes with the request that completes it.
 */

import { useState } from 'react';
import { RoomRegister } from '../../components/RoomRegister.tsx';
import { Notice } from '../../components/Notice.tsx';
import { NewRoomDialog } from '../../components/NewRoomDialog.tsx';
import type { MemberRoom, NewRoom, RoomCursor } from '../../api/client.ts';
import { translate } from '../../i18n/translate.ts';
import type { PresentedFailure } from '../failures.ts';
import type { Load } from '../state.ts';

export interface RegisterViewProps {
  readonly rooms: Load<{
    readonly rooms: readonly MemberRoom[];
    /** Null once the server proved this is the whole register. */
    readonly nextCursor: RoomCursor | null;
  }>;
  readonly loadingMore: boolean;
  /** A failed continuation. The rooms already read stay on screen. */
  readonly pageFailure: string | null;
  /** Present only when the server said this member may create rooms. */
  readonly createRoom: ((room: NewRoom) => Promise<PresentedFailure | null>) | null;
  readonly onLoadMore: () => void;
  readonly onOpen: (roomId: string) => void;
  readonly onRetry: () => void;
}

export function RegisterView({
  rooms,
  loadingMore,
  pageFailure,
  createRoom,
  onLoadMore,
  onOpen,
  onRetry,
}: RegisterViewProps): React.ReactElement {
  const [creating, setCreating] = useState(false);

  const newRoom =
    createRoom === null ? null : (
      <>
        <div className="df-panel__actions">
          <button
            type="button"
            className="df-button df-button--primary"
            onClick={() => {
              setCreating(true);
            }}
          >
            {translate('rooms.new')}
          </button>
        </div>
        <NewRoomDialog
          open={creating}
          onCreate={createRoom}
          onClose={() => {
            setCreating(false);
          }}
        />
      </>
    );

  if (rooms.kind === 'loading')
    return (
      <>
        {newRoom}
        <p className="df-field__help">{translate('rooms.loading')}</p>
      </>
    );

  if (rooms.kind === 'failed')
    return (
      <>
        {newRoom}
        <Notice tone="problem" role="alert">
          {rooms.failure}
        </Notice>
        <button type="button" className="df-button" onClick={onRetry}>
          {translate('app.retry')}
        </button>
      </>
    );

  const partial = rooms.value.nextCursor !== null;

  return (
    <>
      {newRoom}
      {/* A register that stopped short says so rather than reading as every room this
          member can reach. Silence here would be a false statement about access. */}
      {partial ? (
        <Notice tone="caution" role="status">
          {translate('rooms.partial')}
        </Notice>
      ) : null}

      {/* A failed continuation, reported beside the rooms that did load. */}
      {pageFailure === null ? null : (
        <Notice tone="problem" role="alert">
          {pageFailure}
        </Notice>
      )}

      <RoomRegister rooms={rooms.value.rooms} onOpen={onOpen} />

      {/* The action that completes the register. Without it, "this is part of your rooms"
          named a limitation with no way past it. */}
      {partial ? (
        <div className="df-panel__actions">
          <button
            type="button"
            className="df-button"
            data-busy={loadingMore ? 'true' : 'false'}
            disabled={loadingMore}
            onClick={onLoadMore}
          >
            {loadingMore ? translate('rooms.loadingMore') : translate('rooms.more')}
          </button>
        </div>
      ) : null}
    </>
  );
}
