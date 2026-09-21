/**
 * Room register parsing and pagination tests.
 *
 * The register is not decoration: `roomRole` and `accessSource` are how the product
 * EXPLAINS why a room is reachable, `canPublish` is a server decision the surface
 * echoes, and the whole list is what the staffing dialog treats as "the rooms". A
 * blanket cast made all of that whatever the server happened to send, and an unbounded
 * projection left every consumer unable to tell a complete set from a prefix.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRooms, loadRoomWorkspace, ApiError } from './client.ts';

interface Call {
  readonly path: string;
}

const calls: Call[] = [];

function respond(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(payload),
    clone: () => respond(status, payload),
  } as unknown as Response;
}

function stub(reply: (call: Call) => Response): void {
  vi.stubGlobal('fetch', (path: string) => {
    const call: Call = { path };
    calls.push(call);
    return Promise.resolve(reply(call));
  });
}

const ROOM = {
  roomId: 'r'.repeat(32),
  title: 'Series A',
  description: 'Diligence materials',
  state: 'draft',
  revision: 1,
  workingRevision: 1,
  publishedRevision: 0,
  roomRole: 'manager',
  accessSource: 'assignment',
  canPublish: true,
};

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('document', { cookie: '' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parsing', () => {
  it('parses a validated room and reports the page as last', () => {
    stub(() => respond(200, { rooms: [ROOM] }));
    return expect(loadRooms()).resolves.toStrictEqual({
      rooms: [
        {
          roomId: ROOM.roomId,
          title: 'Series A',
          description: 'Diligence materials',
          state: 'draft',
          revision: 1,
          workingRevision: 1,
          publishedRevision: 0,
          roomRole: 'manager',
          accessSource: 'assignment',
          canPublish: true,
        },
      ],
      /* Null means the server PROVED this is the last page, which is not the same as
         not knowing. */
      nextCursor: null,
    });
  });

  it('accepts a room reached through an organization role, with no assignment', () => {
    stub(() =>
      respond(200, { rooms: [{ ...ROOM, roomRole: null, accessSource: 'global_role' }] }),
    );
    return expect(loadRooms()).resolves.toMatchObject({
      rooms: [{ roomRole: null, accessSource: 'global_role' }],
    });
  });

  it('refuses a room role it does not recognize instead of rendering it', async () => {
    // A role the surface cannot explain would state authority the server never described.
    stub(() => respond(200, { rooms: [{ ...ROOM, roomRole: 'owner' }] }));
    await expect(loadRooms()).rejects.toBeInstanceOf(ApiError);
  });

  it('refuses an unrecognized room state', async () => {
    // Room state decides whether viewers can reach anything, so a guess is not available.
    stub(() => respond(200, { rooms: [{ ...ROOM, state: 'frozen' }] }));
    await expect(loadRooms()).rejects.toBeInstanceOf(ApiError);
  });

  it('refuses an unrecognized access source', async () => {
    stub(() => respond(200, { rooms: [{ ...ROOM, accessSource: 'inherited' }] }));
    await expect(loadRooms()).rejects.toBeInstanceOf(ApiError);
  });

  /*
   * ACCESS PROVENANCE IS ONE FACT, NOT TWO FIELDS.
   *
   * `read_member_rooms` derives the source from the role, so neither pairing below can be
   * produced by the reader. They were nevertheless accepted while each field was validated
   * on its own, and both make the surface explain access with something untrue: this is
   * where the product states WHY a room can be opened.
   */
  describe('contradictory access provenance', () => {
    it('refuses an assignment that carries no role', async () => {
      /* An assignment means a colleague staffed this member into the room. With no role
         there is nothing the assignment could have staffed them as, so the row claims a
         grant while withholding what was granted. */
      stub(() =>
        respond(200, { rooms: [{ ...ROOM, roomRole: null, accessSource: 'assignment' }] }),
      );
      await expect(loadRooms()).rejects.toBeInstanceOf(ApiError);
    });

    it('refuses role-derived access that also names an explicit room role', async () => {
      /* An organization role carries Room Manager authority in EVERY room, so an explicit
         `manager` row would advertise something narrower than the authority actually held
         — and a `contributor` one would understate it outright. */
      for (const roomRole of ['manager', 'contributor'] as const) {
        stub(() =>
          respond(200, { rooms: [{ ...ROOM, roomRole, accessSource: 'global_role' }] }),
        );
        await expect(loadRooms(), roomRole).rejects.toBeInstanceOf(ApiError);
      }
    });

    it('accepts both coherent pairings, so the rule refuses only contradictions', async () => {
      stub(() =>
        respond(200, {
          rooms: [{ ...ROOM, roomRole: 'contributor', accessSource: 'assignment' }],
        }),
      );
      await expect(loadRooms()).resolves.toMatchObject({
        rooms: [{ roomRole: 'contributor', accessSource: 'assignment' }],
      });

      stub(() =>
        respond(200, { rooms: [{ ...ROOM, roomRole: null, accessSource: 'global_role' }] }),
      );
      await expect(loadRooms()).resolves.toMatchObject({
        rooms: [{ roomRole: null, accessSource: 'global_role' }],
      });
    });

    it('refuses a room with no access source at all rather than assuming one', async () => {
      const { accessSource, ...withoutSource } = ROOM;
      expect(accessSource).toBe('assignment');
      stub(() => respond(200, { rooms: [withoutSource] }));
      await expect(loadRooms()).rejects.toBeInstanceOf(ApiError);
    });
  });

  it('refuses a non-boolean publish decision rather than coercing it', async () => {
    /*
     * `canPublish` is the server's decision. Coercing a truthy value would offer a
     * Contributor a control the server will reject, and coercing a falsy one would hide
     * a Manager's publish action.
     */
    stub(() => respond(200, { rooms: [{ ...ROOM, canPublish: 'yes' }] }));
    await expect(loadRooms()).rejects.toBeInstanceOf(ApiError);
  });

  it('refuses a missing revision instead of defaulting it', async () => {
    // A defaulted revision would be sent as an optimistic-concurrency expectation.
    const { revision, ...withoutRevision } = ROOM;
    expect(revision).toBe(1);
    stub(() => respond(200, { rooms: [withoutRevision] }));
    await expect(loadRooms()).rejects.toBeInstanceOf(ApiError);
  });
});

describe('pagination', () => {
  const CURSOR = { title: 'Series A', roomId: ROOM.roomId };

  it('carries the cursor the server issued', () => {
    stub(() => respond(200, { rooms: [ROOM], nextCursor: CURSOR }));
    return expect(loadRooms()).resolves.toMatchObject({ nextCursor: CURSOR });
  });

  it('sends both cursor components together, never half of one', async () => {
    // Half a key resumes at a position in neither ordering, skipping or repeating rooms
    // that share a title.
    stub(() => respond(200, { rooms: [] }));
    await loadRooms({ after: CURSOR });
    const path = calls.at(-1)?.path ?? '';
    expect(path).toContain(`afterTitle=${encodeURIComponent(CURSOR.title)}`);
    expect(path).toContain(`afterRoomId=${CURSOR.roomId}`);
  });

  it('requests no cursor on the first page', async () => {
    stub(() => respond(200, { rooms: [] }));
    await loadRooms();
    expect(calls.at(-1)?.path).toBe('/api/rooms');
  });

  it('percent-encodes a title that would otherwise alter the query', async () => {
    /*
     * A title is operator text and may contain `&`, `=`, or a space. An unencoded one
     * would change which parameters the server sees, so the cursor would resume
     * somewhere other than where this page ended.
     */
    stub(() => respond(200, { rooms: [] }));
    await loadRooms({ after: { title: 'A & B = C', roomId: ROOM.roomId } });
    const path = calls.at(-1)?.path ?? '';
    expect(path).toContain('afterTitle=A%20%26%20B%20%3D%20C');
    expect(path).not.toContain('afterTitle=A & B');
  });

  it('refuses a malformed cursor rather than resuming from a guess', async () => {
    stub(() => respond(200, { rooms: [ROOM], nextCursor: { title: 'Series A' } }));
    await expect(loadRooms()).rejects.toBeInstanceOf(ApiError);
  });
});

describe('loadRoomWorkspace', () => {
  const stubJson = (body: unknown): void => {
    stub(() => respond(200, body));
  };
  const base = {
    entryId: 'e'.repeat(32),
    resourceId: 'r'.repeat(32),
    parentFolderId: null,
    displayName: 'Teaser',
    description: '',
    revision: 1,
    stagedRemoved: false,
    depth: 0,
    position: 1,
    canMoveUp: false,
    canMoveDown: false,
    changeKinds: [],
    hasPublishableVersion: true,
    isPublished: false,
  };

  it('keeps a document revision that differs from the entry revision', async () => {
    stubJson({
      entries: [{ ...base, resourceKind: 'document', documentRevision: 4 }],
      trash: [],
      retentionDays: 30,
    });
    const { entries } = await loadRoomWorkspace('x'.repeat(32));
    expect(entries[0]).toMatchObject({
      resourceKind: 'document',
      revision: 1,
      documentRevision: 4,
    });
  });

  it.each([
    [{ ...base, resourceKind: 'document', documentRevision: null }],
    [{ ...base, resourceKind: 'folder', documentRevision: 2 }],
  ])('fails closed on a revision that contradicts the kind', async (entry) => {
    stubJson({ entries: [entry], trash: [], retentionDays: 30 });
    await expect(loadRoomWorkspace('x'.repeat(32))).rejects.toMatchObject({
      failure: 'unavailable',
    });
  });

  it('fails closed on a fractional revision', async () => {
    stubJson({
      entries: [{ ...base, revision: 1.5, resourceKind: 'document', documentRevision: 4 }],
      trash: [],
      retentionDays: 30,
    });
    await expect(loadRoomWorkspace('x'.repeat(32))).rejects.toMatchObject({
      failure: 'unavailable',
    });
  });

  it('fails closed on a fractional documentRevision', async () => {
    stubJson({
      entries: [{ ...base, resourceKind: 'document', documentRevision: 4.5 }],
      trash: [],
      retentionDays: 30,
    });
    await expect(loadRoomWorkspace('x'.repeat(32))).rejects.toMatchObject({
      failure: 'unavailable',
    });
  });
});
