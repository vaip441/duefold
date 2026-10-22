import { describe, expect, it } from 'vitest';
import type { WorkingEntry } from '../../api/client.ts';
import { removalTargets, roomEntries } from './RoomView.tsx';

describe('roomEntries', () => {
  it('returns the same empty list on every render while the room is not ready', () => {
    // RoomView publishes this list to the frame from an effect keyed on its identity, and the
    // frame stores it in state. A fresh list per render re-renders the view without end.
    expect(roomEntries({ kind: 'loading' })).toBe(roomEntries({ kind: 'loading' }));
    expect(roomEntries({ kind: 'failed', failure: null })).toBe(
      roomEntries({ kind: 'loading' }),
    );
    expect(roomEntries({ kind: 'loading' })).toHaveLength(0);
  });
});

describe('removalTargets', () => {
  const entry = (
    entryId: string,
    parentFolderId: string | null,
    resourceKind: 'folder' | 'document',
    stagedRemoved = false,
  ): WorkingEntry =>
    ({
      entryId,
      resourceId: `${entryId}-resource`,
      parentFolderId: parentFolderId === null ? null : `${parentFolderId}-resource`,
      resourceKind,
      stagedRemoved,
    }) as WorkingEntry;

  it('leaves entries under a selected or already staged folder to that folder', () => {
    const entries = [
      entry('legal', null, 'folder'),
      entry('contracts', 'legal', 'folder'),
      entry('spa', 'contracts', 'document'),
      entry('archive', null, 'folder', true),
      entry('old', 'archive', 'document'),
      entry('deck', null, 'document'),
      entry('notes', null, 'document', true),
    ];

    expect(
      removalTargets(
        entries,
        entries.map(({ entryId }) => entryId),
      ).map(({ entryId }) => entryId),
    ).toEqual(['legal', 'deck']);
    expect(removalTargets(entries, ['spa', 'old']).map(({ entryId }) => entryId)).toEqual([
      'spa',
    ]);
  });
});
