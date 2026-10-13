import { describe, expect, it } from 'vitest';
import { roomEntries } from './RoomView.tsx';

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
