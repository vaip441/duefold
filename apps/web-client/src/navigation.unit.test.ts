import { describe, expect, it } from 'vitest';
import {
  formatMemberLocation,
  formatViewerLocation,
  parseMemberLocation,
  parseViewerLocation,
} from './navigation.ts';

const ROOM = 'r'.repeat(32);
const DOCUMENT = 'd'.repeat(32);

describe('member locations', () => {
  it('round-trips every view through the address bar', () => {
    for (const location of [
      { kind: 'rooms' },
      { kind: 'administration', section: 'status' },
      { kind: 'room', roomId: ROOM, section: 'structure' },
      { kind: 'room', roomId: ROOM, section: 'participants' },
    ] as const)
      expect(parseMemberLocation(formatMemberLocation(location))).toEqual(location);
  });

  it('falls back to the register for a path it does not recognise', () => {
    // A mistyped or foreign path lands somewhere real rather than on a blank view.
    expect(parseMemberLocation('/rooms/not an id')).toEqual({ kind: 'rooms' });
    expect(parseMemberLocation('/read')).toEqual({ kind: 'rooms' });
    expect(parseMemberLocation('/rooms/%3Cscript%3E')).toEqual({ kind: 'rooms' });
  });
});

describe('viewer locations', () => {
  it('keeps the room, document, and page', () => {
    const location = { kind: 'room', roomId: ROOM, documentId: DOCUMENT, page: 3 } as const;
    expect(formatViewerLocation(location)).toBe(`/rooms/${ROOM}/documents/${DOCUMENT}?page=3`);
    expect(parseViewerLocation(`/rooms/${ROOM}/documents/${DOCUMENT}`, '?page=3')).toEqual(
      location,
    );
  });

  it('reads a missing or nonsensical page as the first', () => {
    for (const search of ['', '?page=0', '?page=-4', '?page=two'])
      expect(parseViewerLocation(`/rooms/${ROOM}/documents/${DOCUMENT}`, search)).toMatchObject(
        {
          page: 1,
        },
      );
  });

  it('treats the sign-in path as the room list', () => {
    expect(parseViewerLocation('/read', '')).toEqual({ kind: 'rooms' });
  });
});
