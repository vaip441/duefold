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
  applyDefaultExpiry,
  applyRetention,
  applyVisibility,
  cancelPurge,
  loadRoomSettings,
  reviewDefaultExpiry,
  reviewPurge,
  reviewRetention,
  reviewVisibility,
  schedulePurge,
  setDocumentDownloadPolicy,
  setRoomDownloadPolicy,
  type DefaultExpiryImpact,
  type DownloadPolicy,
  type PurgeImpact,
  type RetentionImpact,
  type ReviewedVisibility,
  type RoomSettingsView,
  type VisibilityChange,
  type VisibilityImpact,
} from '../api/client.ts';
import { presentFailure, type PresentedFailure } from './failures.ts';
import { committed, settle, type Outcome } from './outcome.ts';
import { readFor, roomDownloadPolicy, type StructureDownloads } from './room-settings.ts';
import type { Load } from './state.ts';

export interface RoomSettingsSection {
  readonly load: Load<RoomSettingsView>;
  /** The presented cause of a failed load, for choosing its recovery. */
  readonly failure: PresentedFailure | null;
  readonly reload: () => void;
  readonly reviewVisibility: (state: ReviewedVisibility) => Promise<Outcome<VisibilityImpact>>;
  readonly applyVisibility: (change: VisibilityChange) => Promise<PresentedFailure | null>;
  readonly setRoomDownloadPolicy: (
    policy: DownloadPolicy | null,
    expectedRoomRevision: number,
  ) => Promise<PresentedFailure | null>;
  readonly reviewDefaultExpiry: (
    expiresAt: string | null,
  ) => Promise<Outcome<DefaultExpiryImpact>>;
  readonly applyDefaultExpiry: (
    expiresAt: string | null,
    expectedRoomRevision: number,
    confirmation: string,
  ) => Promise<PresentedFailure | null>;
  readonly reviewRetention: (years: number) => Promise<Outcome<RetentionImpact>>;
  readonly applyRetention: (
    years: number,
    expectedRevision: number,
    confirmation: string,
  ) => Promise<PresentedFailure | null>;
  readonly reviewPurge: () => Promise<Outcome<PurgeImpact>>;
  readonly schedulePurge: (
    expectedRevision: number,
    confirmation: string,
  ) => Promise<PresentedFailure | null>;
  readonly cancelPurge: (purgeId: string) => Promise<PresentedFailure | null>;
  readonly structureDownloads: (onDocumentChanged: () => void) => StructureDownloads | null;
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
  const view = current !== null && current.load.kind === 'ready' ? current.load.value : null;
  return {
    load,
    failure: current?.failure ?? null,
    reload,
    reviewVisibility: (state) => settle(reviewVisibility(roomId, state)),
    applyVisibility: (change) => commit(applyVisibility(roomId, change)),
    setRoomDownloadPolicy: (policy, expected) =>
      commit(setRoomDownloadPolicy(roomId, policy, expected)),
    reviewDefaultExpiry: (expiresAt) => settle(reviewDefaultExpiry(roomId, expiresAt)),
    applyDefaultExpiry: (expiresAt, expected, confirmation) =>
      commit(applyDefaultExpiry(roomId, expiresAt, expected, confirmation)),
    reviewRetention: (years) => settle(reviewRetention(roomId, years)),
    applyRetention: (years, expected, confirmation) =>
      commit(applyRetention(roomId, years, expected, confirmation)),
    reviewPurge: () => settle(reviewPurge(roomId)),
    schedulePurge: (expected, confirmation) =>
      commit(schedulePurge(roomId, expected, confirmation)),
    cancelPurge: (purgeId) => commit(cancelPurge(purgeId)),
    structureDownloads: (onDocumentChanged) =>
      view === null
        ? null
        : {
            overrides: view.downloadOverrides,
            inherited: roomDownloadPolicy(view.settings),
            change: async (entry, policy) => {
              const failure = await commit(
                setDocumentDownloadPolicy(entry.resourceId, policy, entry.documentRevision),
              );
              if (failure === null) onDocumentChanged();
              return failure;
            },
            reload: () => {
              reload();
              onDocumentChanged();
            },
          },
  };
}
