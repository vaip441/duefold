import { describe, expect, it } from 'vitest';
import type { RoomSettings } from '../api/client.ts';
import { readFor, visibilityNotes } from './room-settings.ts';

const base: RoomSettings = {
  roomId: 'r'.repeat(32),
  state: 'draft',
  revision: 1,
  publishedRevision: 0,
  auditRetentionYears: 7,
  defaultGrantExpiresAt: null,
  downloadPolicy: null,
  installationDownloadPolicy: 'deny',
  purge: null,
  capabilities: {
    publish: false,
    archive: true,
    returnToDraft: false,
    setRetention: false,
    schedulePurge: false,
    cancelPurge: false,
  },
};

describe('visibilityNotes', () => {
  it('explains why a never-published draft cannot be published yet', () => {
    expect(visibilityNotes(base)).toStrictEqual(['settings.visibility.publishStructureFirst']);
  });

  it('explains why a room held by its purge cannot return to draft', () => {
    expect(
      visibilityNotes({
        ...base,
        state: 'archived',
        publishedRevision: 1,
        purge: {
          purgeId: 'p'.repeat(32),
          state: 'scheduled',
          purgeAfter: '2026-10-21T00:00:00.000Z',
        },
      }),
    ).toStrictEqual(['settings.visibility.pinnedByPurge']);
  });
});

describe('readFor', () => {
  const ready = { roomId: 'a'.repeat(32), load: { kind: 'ready', value: 7 } } as const;

  it('shows nothing when no room is open', () => {
    expect(readFor(ready, null)).toBeNull();
  });

  it('shows the read that describes the room being asked about', () => {
    expect(readFor(ready, ready.roomId)).toStrictEqual(ready.load);
  });

  /*
   * THE CASE THAT MATTERS. Opening room B while room A's request is still in flight, then A
   * resolving: the reader still holds A's row, and answering it here would put one room's
   * revision, capabilities and state on another room's surface — every optimistic-concurrency
   * write from that surface would then carry the wrong expectation.
   */
  it('reports loading rather than another room\u2019s value when a late read arrives', () => {
    expect(readFor(ready, 'b'.repeat(32))).toStrictEqual({ kind: 'loading' });
  });

  it('reports loading before any read has arrived', () => {
    expect(readFor(null, 'b'.repeat(32))).toStrictEqual({ kind: 'loading' });
  });

  /* A failed read is still that room's answer, so it is shown rather than replaced by
     loading: an unreachable room must not look like one that has not answered yet. */
  it('keeps a failed read for the room it belongs to', () => {
    const failed = {
      roomId: 'c'.repeat(32),
      load: { kind: 'failed', failure: 'No.' },
    } as const;
    expect(readFor(failed, failed.roomId)).toStrictEqual(failed.load);
  });
});
