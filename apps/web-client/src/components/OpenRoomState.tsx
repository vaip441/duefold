/**
 * What the frame shows for an open room that is not ready yet.
 *
 * The open room's register row is read by id, so it has its own outcome: still arriving, or
 * unreachable. Both are answered BEFORE the room is mounted, because a room reduced to a
 * missing row looks like one that is still loading while every revision-dependent control
 * inside it is silently inert. An unreachable room and an unknown id are the same answer
 * here, as they are on the wire.
 */
import { translate } from '../i18n/translate.ts';
import type { MemberRoom } from '../api/client.ts';
import type { Load } from '../workspace/state.ts';
import { Notice } from './Notice.tsx';

export interface OpenRoomStateProps {
  readonly load: Load<MemberRoom>;
  readonly onRetry: () => void;
  readonly onLeave: () => void;
}

export function OpenRoomState({
  load,
  onRetry,
  onLeave,
}: OpenRoomStateProps): React.ReactElement | null {
  if (load.kind === 'ready') return null;
  if (load.kind === 'loading')
    return (
      <p className="df-field__help" role="status">
        {translate('rooms.opening')}
      </p>
    );
  return (
    <>
      <Notice tone="problem" role="alert">
        {load.failure}
      </Notice>
      {/* Two ways out, because the cause decides which one works: a transient failure is
          worth retrying, and a room that is genuinely not theirs never will be. */}
      <div className="df-panel__actions">
        <button type="button" className="df-button" onClick={onRetry}>
          {translate('app.retry')}
        </button>
        <button type="button" className="df-button" onClick={onLeave}>
          {translate('rooms.backToRegister')}
        </button>
      </div>
    </>
  );
}
