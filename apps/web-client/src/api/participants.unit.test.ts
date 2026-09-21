import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCounterparty,
  loadParticipants,
  placeViewerInCounterparty,
  removeViewerFromCounterparty,
} from './participants.ts';

const ID = 'c'.repeat(32);
function stub(body: unknown, status = 200): void {
  vi.stubGlobal('document', { cookie: '__Host-duefold_csrf=token' });
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })),
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadParticipants', () => {
  it('returns counterparties, including those nobody is placed in yet', async () => {
    stub({
      participants: [],
      counterparties: [{ counterpartyId: ID, name: 'Buyer A', revision: 1, viewerCount: 0 }],
    });
    expect((await loadParticipants('r'.repeat(32))).counterparties).toStrictEqual([
      { counterpartyId: ID, name: 'Buyer A', revision: 1, viewerCount: 0 },
    ]);
  });

  it('fails closed on a counterparty it cannot read', async () => {
    stub({
      participants: [],
      counterparties: [{ counterpartyId: ID, name: 'Buyer A', revision: 1, viewerCount: -1 }],
    });
    await expect(loadParticipants('r'.repeat(32))).rejects.toMatchObject({
      failure: 'unavailable',
    });
  });

  it('fails closed when revision is not an integer', async () => {
    stub({
      participants: [],
      counterparties: [{ counterpartyId: ID, name: 'Buyer A', revision: 1.5, viewerCount: 0 }],
    });
    await expect(loadParticipants('r'.repeat(32))).rejects.toMatchObject({
      failure: 'unavailable',
    });
  });
});

describe('counterparty mutations', () => {
  it('creates a counterparty normalizing name to NFC', async () => {
    vi.stubGlobal('document', { cookie: '__Host-duefold_csrf=token' });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ counterpartyId: ID, roomRevision: 2 }), { status: 201 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    await createCounterparty({
      roomId: 'r'.repeat(32),
      name: 'Buyer \u0041',
      expectedRoomRevision: 1,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/counterparties'),
      expect.objectContaining({
        body: JSON.stringify({
          action: 'create',
          roomId: 'r'.repeat(32),
          name: 'Buyer A',
          expectedRoomRevision: 1,
        }),
      }),
    );
  });

  it('places a viewer in a counterparty', async () => {
    vi.stubGlobal('document', { cookie: '__Host-duefold_csrf=token' });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ roomRevision: 3 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await placeViewerInCounterparty({
      roomId: 'r'.repeat(32),
      counterpartyId: ID,
      viewerId: 'v'.repeat(32),
      expectedRoomRevision: 2,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/counterparties'),
      expect.objectContaining({
        body: JSON.stringify({
          action: 'assign-viewer',
          roomId: 'r'.repeat(32),
          counterpartyId: ID,
          viewerId: 'v'.repeat(32),
          expectedRoomRevision: 2,
        }),
      }),
    );
  });

  it('removes a viewer from a counterparty', async () => {
    vi.stubGlobal('document', { cookie: '__Host-duefold_csrf=token' });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ roomRevision: 4 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await removeViewerFromCounterparty({
      roomId: 'r'.repeat(32),
      viewerId: 'v'.repeat(32),
      expectedRoomRevision: 3,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/counterparties'),
      expect.objectContaining({
        body: JSON.stringify({
          action: 'remove-viewer',
          roomId: 'r'.repeat(32),
          viewerId: 'v'.repeat(32),
          expectedRoomRevision: 3,
        }),
      }),
    );
  });
});

describe('loadParticipants participant parsing', () => {
  const grant = {
    grantId: 'g'.repeat(32),
    source: 'direct',
    targetKind: 'room',
    folderId: null,
    documentId: null,
    expiresAt: null,
    effective: true,
    revision: 1,
  };
  const participant = {
    viewerId: 'v'.repeat(32),
    email: 'reader@example.com',
    membershipState: 'active',
    membershipRevision: 2,
    counterpartyId: null,
    counterpartyName: null,
    grants: [grant],
  };

  const load = async (participants: readonly unknown[]) => {
    vi.stubGlobal('document', { cookie: '__Host-duefold_csrf=token' });
    stub({ participants, counterparties: [] });
    return loadParticipants(ID);
  };

  it('parses a whole participant, grants included', async () => {
    const roster = await load([participant]);
    expect(roster.participants).toStrictEqual([participant]);
  });

  /*
   * Each of these is a field a cast would have waved through. This is the answer a Manager
   * reads access off, so a body it cannot vouch for must fail closed rather than be drawn.
   */
  it.each([
    ['an unknown membership state', { ...participant, membershipState: 'suspended' }],
    [
      'a non-boolean effective flag',
      { ...participant, grants: [{ ...grant, effective: 'yes' }] },
    ],
    [
      'an unknown grant source',
      { ...participant, grants: [{ ...grant, source: 'inherited' }] },
    ],
    ['an unknown target kind', { ...participant, grants: [{ ...grant, targetKind: 'page' }] }],
    ['a fractional grant revision', { ...participant, grants: [{ ...grant, revision: 1.5 }] }],
    ['a zero membership revision', { ...participant, membershipRevision: 0 }],
    ['an unparseable expiry', { ...participant, grants: [{ ...grant, expiresAt: 'soon' }] }],
    ['a missing email', { ...participant, email: undefined }],
    ['grants that are not an array', { ...participant, grants: {} }],
    /* A placement is an id and a name together; one alone names a counterparty nobody can
       read, which would render as membership of something unnameable. */
    ['a counterparty id with no name', { ...participant, counterpartyId: 'c'.repeat(32) }],
    ['a counterparty name with no id', { ...participant, counterpartyName: 'Buyer A' }],
  ])('refuses %s', async (_label, malformed) => {
    await expect(load([malformed])).rejects.toMatchObject({ failure: 'unavailable' });
  });
});
