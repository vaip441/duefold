/**
 * The open room's register row, read by id.
 *
 * Revision-dependent controls inside a room need this row. Reading it by id rather than
 * finding it in the loaded register page means a room on an unloaded page — including one
 * just created — is as usable as any other. The row is keyed by room id, so switching
 * rooms never shows one room's revision for another.
 */
import { useEffect, useState } from 'react';
import { loadRoom, type MemberRoom } from '../api/client.ts';
import { translate } from '../i18n/translate.ts';
import { presentFailure } from './failures.ts';
import { readFor } from './room-settings.ts';
import type { Load } from './state.ts';

export function useOpenRoom(
  roomId: string | null,
  reloadToken: number,
): Load<MemberRoom> | null {
  const [read, setRead] = useState<{
    readonly roomId: string;
    readonly load: Load<MemberRoom>;
  } | null>(null);

  useEffect(() => {
    if (roomId === null) return;
    const controller = new AbortController();
    loadRoom(roomId, controller.signal).then(
      (room) => {
        setRead({
          roomId,
          load:
            room === null
              ? { kind: 'failed', failure: translate('rooms.unavailable') }
              : { kind: 'ready', value: room },
        });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setRead({ roomId, load: { kind: 'failed', failure: presentFailure(error).body } });
      },
    );
    return () => {
      controller.abort();
    };
  }, [roomId, reloadToken]);

  return readFor(read, roomId);
}
