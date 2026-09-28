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

  it('round-trips the investor preview, with and without an open document', () => {
    for (const location of [
      { kind: 'preview', roomId: ROOM, documentId: null, page: 1 },
      { kind: 'preview', roomId: ROOM, documentId: DOCUMENT, page: 1 },
      { kind: 'preview', roomId: ROOM, documentId: DOCUMENT, page: 7 },
    ] as const) {
      const [pathname = '', search = ''] = formatMemberLocation(location).split('?');
      expect(parseMemberLocation(pathname, search === '' ? '' : `?${search}`)).toEqual(
        location,
      );
    }
    expect(
      formatMemberLocation({ kind: 'preview', roomId: ROOM, documentId: DOCUMENT, page: 7 }),
    ).toBe(`/rooms/${ROOM}/preview/documents/${DOCUMENT}?page=7`);
  });

  it('reads a malformed preview page or document as the room preview start', () => {
    for (const search of ['', '?page=0', '?page=-3', '?page=two'])
      expect(
        parseMemberLocation(`/rooms/${ROOM}/preview/documents/${DOCUMENT}`, search),
      ).toEqual({ kind: 'preview', roomId: ROOM, documentId: DOCUMENT, page: 1 });
    expect(parseMemberLocation(`/rooms/${ROOM}/preview/documents/bad`, '?page=4')).toEqual({
      kind: 'preview',
      roomId: ROOM,
      documentId: null,
      page: 1,
    });
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
