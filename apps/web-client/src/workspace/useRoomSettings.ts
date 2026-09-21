/**
 * One room's settings: the load, and every change a Room Manager can make to them.
 *
 * Reads return an `Outcome`; mutations return null when they committed. A committed
 * change re-reads the settings and tells the frame, because the room revision other
 * sections send has moved. No state here describes a mutation in flight: the dialog that
 * started it owns that.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  applyVisibility,
  loadRoomSettings,
  reviewVisibility,
  type ReviewedVisibility,
  type RoomSettingsView,
  type VisibilityChange,
  type VisibilityImpact,
} from '../api/client.ts';
import { presentFailure, type PresentedFailure } from './failures.ts';
import { committed, settle, type Outcome } from './outcome.ts';
import { readFor } from './room-settings.ts';
import type { Load } from './state.ts';

export interface RoomSettingsSection {
  readonly load: Load<RoomSettingsView>;
  /** The presented cause of a failed load, for choosing its recovery. */
  readonly failure: PresentedFailure | null;
  readonly reload: () => void;
  readonly reviewVisibility: (state: ReviewedVisibility) => Promise<Outcome<VisibilityImpact>>;
  readonly applyVisibility: (change: VisibilityChange) => Promise<PresentedFailure | null>;
}

interface Read {
  readonly roomId: string;
  readonly load: Load<RoomSettingsView>;
  readonly failure: PresentedFailure | null;
}

export function useRoomSettings(
  roomId: string | null,
  onChanged: () => void,
): RoomSettingsSection | null {
  const [token, setToken] = useState(0);
  const [read, setRead] = useState<Read | null>(null);

  useEffect(() => {
    if (roomId === null) return;
    const controller = new AbortController();
    loadRoomSettings(roomId, controller.signal).then(
      (value) => {
        setRead({ roomId, load: { kind: 'ready', value }, failure: null });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const failure = presentFailure(error);
        setRead({ roomId, load: { kind: 'failed', failure: failure.body }, failure });
      },
    );
    return () => {
      controller.abort();
    };
  }, [roomId, token]);

  /*
   * Drops the current read as well as asking for another. Keeping the old one visible while
   * the next is in flight would leave the previous capabilities on screen and pressable, so a
   * Manager could start a change the server has just stopped offering.
   */
  const reload = useCallback(() => {
    setRead(null);
    setToken((current) => current + 1);
  }, []);

  /* Alive across the await, so a mutation that resolves after this section was replaced
     neither reloads a room nobody is looking at nor calls the frame back. */
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const commit = useCallback(
    async (work: Promise<unknown>): Promise<PresentedFailure | null> => {
      const failure = await committed(work);
      if (failure === null && mounted.current) {
        reload();
        onChanged();
      }
      return failure;
    },
    [reload, onChanged],
  );

  const load = readFor(read, roomId);
  if (roomId === null || load === null) return null;
  const current = read?.roomId === roomId ? read : null;
  return {
    load,
    failure: current?.failure ?? null,
    reload,
    reviewVisibility: (state) => settle(reviewVisibility(roomId, state)),
    applyVisibility: (change) => commit(applyVisibility(roomId, change)),
  };
}
