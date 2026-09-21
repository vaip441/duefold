/**
 * Counterparties: the groups viewers are placed in, and what a placement grants.
 *
 * A counterparty's grants reach everyone placed in it, so a placement IS an access change.
 * Removal revokes the placement rather than deleting it and leaves the counterparty's grants
 * alone, because they belong to the counterparty and not to the departing viewer.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import { closeRoutePools, databasePool, migrationPool } from './support/route-fixture.ts';
import { roomRevision, seedViewerWithRoomGrant } from './support/room-fixture.ts';
import {
  counterparties,
  policies,
  roster,
  seedPolicyFixture,
  type PolicyFixture,
} from './support/policy-fixture.ts';

let fixture: PolicyFixture;
let ownerId: string;
let managerId: string;
let contributorId: string;
let roomId: string;
let otherRoomId: string;
let documentId: string;
let viewerId: string;

beforeAll(async () => {
  fixture = await seedPolicyFixture('Room counterparties');
  ({ ownerId, managerId, contributorId, roomId, otherRoomId, documentId, viewerId } = fixture);
});

afterAll(closeRoutePools);

/**
 * Creates a counterparty and returns its id. Each case that needs one makes its own, because
 * a case reusing an id another case created passes or fails depending on execution order.
 */
async function createdCounterparty(name: string, room = roomId): Promise<string> {
  /* The Owner reaches every room; the Manager is only staffed into the first one. */
  const created = await counterparties(room === roomId ? managerId : ownerId, {
    action: 'create',
    roomId: room,
    name,
    expectedRoomRevision: await roomRevision(room),
  });
  if (created.statusCode !== 201)
    throw new Error(`counterparty not created: ${created.statusCode}`);
  return created.json<{ counterpartyId: string }>().counterpartyId;
}

describe('counterparties', () => {
  it('creates a counterparty and lists it before anyone is placed in it', async () => {
    const buyerId = await createdCounterparty('Buyer A');
    const listed = await roster(managerId, roomId);
    expect(listed.json<{ counterparties: unknown[] }>().counterparties).toStrictEqual([
      { counterpartyId: buyerId, name: 'Buyer A', revision: 1, viewerCount: 0 },
    ]);
  });

  it('refuses a second counterparty with the same name after normalization', async () => {
    const duplicate = await counterparties(managerId, {
      action: 'create',
      roomId,
      name: 'buyer a',
      expectedRoomRevision: await roomRevision(roomId),
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toStrictEqual({
      error: {
        code: 'CONFLICT',
        message: 'The resource changed before this request completed. Reload and try again.',
      },
    });
  });

  it('refuses a name that is only spaces', async () => {
    const blank = await counterparties(managerId, {
      action: 'create',
      roomId,
      name: '   ',
      expectedRoomRevision: await roomRevision(roomId),
    });
    expect(blank.statusCode).toBe(400);
  });

  it('places a viewer, refuses a second placement in the same room, and removes without deleting', async () => {
    const buyerId = await createdCounterparty(`Buyer ${createOpaqueId().slice(0, 8)}`);
    const placed = await counterparties(managerId, {
      action: 'assign-viewer',
      roomId,
      counterpartyId: buyerId,
      viewerId,
      expectedRoomRevision: await roomRevision(roomId),
    });
    expect(placed.statusCode).toBe(200);

    const other = await counterparties(managerId, {
      action: 'create',
      roomId,
      name: 'Buyer B',
      expectedRoomRevision: await roomRevision(roomId),
    });
    const second = await counterparties(managerId, {
      action: 'assign-viewer',
      roomId,
      counterpartyId: other.json<{ counterpartyId: string }>().counterpartyId,
      viewerId,
      expectedRoomRevision: await roomRevision(roomId),
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toStrictEqual({
      error: {
        code: 'CONFLICT',
        message: 'The resource changed before this request completed. Reload and try again.',
      },
    });

    const removed = await counterparties(managerId, {
      action: 'remove-viewer',
      roomId,
      viewerId,
      expectedRoomRevision: await roomRevision(roomId),
    });
    expect(removed.statusCode).toBe(200);
    expect(
      (
        await migrationPool.query(
          'SELECT state FROM counterparty_viewer WHERE viewer_id=$1 AND room_id=$2',
          [viewerId, roomId],
        )
      ).rows,
    ).toEqual([{ state: 'revoked' }]);
    expect(
      (
        await migrationPool.query(
          "SELECT resource_id FROM audit_event WHERE event_type='participant.counterparty.remove' AND subject_id=$1",
          [viewerId],
        )
      ).rows,
    ).toEqual([{ resource_id: buyerId }]);

    const again = await counterparties(managerId, {
      action: 'remove-viewer',
      roomId,
      viewerId,
      expectedRoomRevision: await roomRevision(roomId),
    });
    expect(again.statusCode).toBe(409);
  });

  it('refuses a Contributor every counterparty action and the roster', async () => {
    const buyerId = await createdCounterparty(`Buyer ${createOpaqueId().slice(0, 8)}`);
    expect(
      (
        await counterparties(contributorId, {
          action: 'create',
          roomId,
          name: 'Nope',
          expectedRoomRevision: await roomRevision(roomId),
        })
      ).statusCode,
    ).toBe(403);

    expect(
      (
        await counterparties(contributorId, {
          action: 'assign-viewer',
          roomId,
          counterpartyId: buyerId,
          viewerId,
          expectedRoomRevision: await roomRevision(roomId),
        })
      ).statusCode,
    ).toBe(403);

    expect(
      (
        await counterparties(contributorId, {
          action: 'remove-viewer',
          roomId,
          viewerId,
          expectedRoomRevision: await roomRevision(roomId),
        })
      ).statusCode,
    ).toBe(403);

    expect((await roster(contributorId, roomId)).statusCode).toBe(403);
  });

  it('decides authority before anything else for counterparty mutations', async () => {
    const buyerId = await createdCounterparty(`Buyer ${createOpaqueId().slice(0, 8)}`);
    const contributorCreateStale = await counterparties(contributorId, {
      action: 'create',
      roomId,
      name: 'Contributor New',
      expectedRoomRevision: (await roomRevision(roomId)) - 1,
    });
    expect(contributorCreateStale.statusCode).toBe(403);

    const contributorCreateDup = await counterparties(contributorId, {
      action: 'create',
      roomId,
      name: 'Buyer A',
      expectedRoomRevision: await roomRevision(roomId),
    });
    expect(contributorCreateDup.statusCode).toBe(403);

    const contributorAssignStale = await counterparties(contributorId, {
      action: 'assign-viewer',
      roomId,
      counterpartyId: buyerId,
      viewerId,
      expectedRoomRevision: (await roomRevision(roomId)) - 1,
    });
    expect(contributorAssignStale.statusCode).toBe(403);

    const contributorRemoveStale = await counterparties(contributorId, {
      action: 'remove-viewer',
      roomId,
      viewerId,
      expectedRoomRevision: (await roomRevision(roomId)) - 1,
    });
    expect(contributorRemoveStale.statusCode).toBe(403);

    const contributorRemoveNoop = await counterparties(contributorId, {
      action: 'remove-viewer',
      roomId,
      viewerId,
      expectedRoomRevision: await roomRevision(roomId),
    });
    expect(contributorRemoveNoop.statusCode).toBe(403);
  });

  it('preserves invariant 7: revocation revokes placement and terminates counterparty grants', async () => {
    const cpResp = await counterparties(managerId, {
      action: 'create',
      roomId,
      name: 'Grant Partner',
      expectedRoomRevision: await roomRevision(roomId),
    });
    expect(cpResp.statusCode).toBe(201);
    const cpId = cpResp.json<{ counterpartyId: string }>().counterpartyId;

    const cpGrantId = createOpaqueId();
    await migrationPool.query(
      `INSERT INTO access_grant(id,room_id,grantee_kind,counterparty_id,target_kind,document_id,state,created_by)
       VALUES($1,$2,'counterparty',$3,'document',$4,'active',$5)`,
      [cpGrantId, roomId, cpId, documentId, managerId],
    );

    const placeResp = await counterparties(managerId, {
      action: 'assign-viewer',
      roomId,
      counterpartyId: cpId,
      viewerId,
      expectedRoomRevision: await roomRevision(roomId),
    });
    expect(placeResp.statusCode).toBe(200);

    const grantsWhileActive = (
      await migrationPool.query<{ grant_id: string; source: string }>(
        'SELECT grant_id, source FROM effective_access_grants($1,$2)',
        [viewerId, roomId],
      )
    ).rows;
    expect(grantsWhileActive).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'direct' }),
        expect.objectContaining({ grant_id: cpGrantId, source: 'counterparty' }),
      ]),
    );

    const removeResp = await counterparties(managerId, {
      action: 'remove-viewer',
      roomId,
      viewerId,
      expectedRoomRevision: await roomRevision(roomId),
    });
    expect(removeResp.statusCode).toBe(200);

    const placements = (
      await migrationPool.query<{ counterparty_id: string; state: string }>(
        'SELECT counterparty_id, state FROM counterparty_viewer WHERE viewer_id=$1 AND room_id=$2 AND counterparty_id=$3',
        [viewerId, roomId, cpId],
      )
    ).rows;
    expect(placements).toEqual([{ counterparty_id: cpId, state: 'revoked' }]);

    const grantsAfterRemoval = (
      await migrationPool.query<{ grant_id: string; source: string }>(
        'SELECT grant_id, source FROM effective_access_grants($1,$2)',
        [viewerId, roomId],
      )
    ).rows;
    expect(grantsAfterRemoval.some((g) => g.source === 'counterparty')).toBe(false);
    expect(grantsAfterRemoval.some((g) => g.source === 'direct')).toBe(true);

    const replaceResp = await counterparties(managerId, {
      action: 'assign-viewer',
      roomId,
      counterpartyId: cpId,
      viewerId,
      expectedRoomRevision: await roomRevision(roomId),
    });
    expect(replaceResp.statusCode).toBe(200);

    const grantsAfterReplace = (
      await migrationPool.query<{ grant_id: string; source: string }>(
        'SELECT grant_id, source FROM effective_access_grants($1,$2)',
        [viewerId, roomId],
      )
    ).rows;
    expect(grantsAfterReplace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'direct' }),
        expect.objectContaining({ grant_id: cpGrantId, source: 'counterparty' }),
      ]),
    );

    const allPlacements = (
      await migrationPool.query<{ state: string }>(
        'SELECT state FROM counterparty_viewer WHERE viewer_id=$1 AND room_id=$2 AND counterparty_id=$3 ORDER BY created_at ASC',
        [viewerId, roomId, cpId],
      )
    ).rows;
    expect(allPlacements.map((r) => r.state)).toEqual(['revoked', 'active']);

    await counterparties(managerId, {
      action: 'remove-viewer',
      roomId,
      viewerId,
      expectedRoomRevision: await roomRevision(roomId),
    });
  });

  it('isolates counterparties across rooms and counts only active placements', async () => {
    /* Found by id, not by name: two cases creating a counterparty each would otherwise have to
       agree on a name, and the name is what the room's uniqueness rule bounds. */
    const buyerId = await createdCounterparty(`Buyer ${createOpaqueId().slice(0, 8)}`);
    const otherId = await createdCounterparty('Other Room CP', otherRoomId);

    const listed = async (memberId: string, room: string) =>
      (await roster(memberId, room)).json<{
        counterparties: { counterpartyId: string; viewerCount: number }[];
      }>().counterparties;

    const count = async (memberId: string, room: string, cp: string) =>
      (await listed(memberId, room)).find((c) => c.counterpartyId === cp)?.viewerCount;
    const ids = async (memberId: string, room: string) =>
      (await listed(memberId, room)).map((c) => c.counterpartyId);

    /* Neither room's list mentions the other's counterparty. Earlier cases left their own
       counterparties in room A, so this asserts isolation rather than an exact list. */
    expect(await ids(managerId, roomId)).toContain(buyerId);
    expect(await ids(managerId, roomId)).not.toContain(otherId);
    expect(await ids(ownerId, otherRoomId)).toEqual([otherId]);
    expect(await count(managerId, roomId, buyerId)).toBe(0);

    await counterparties(managerId, {
      action: 'assign-viewer',
      roomId,
      counterpartyId: buyerId,
      viewerId,
      expectedRoomRevision: await roomRevision(roomId),
    });
    expect(await count(managerId, roomId, buyerId)).toBe(1);
    /* The placement is in room A, so room B's count must not move. */
    expect(await count(ownerId, otherRoomId, otherId)).toBe(0);

    /* A revoked placement is not a member of the counterparty, so it is not counted. */
    await counterparties(managerId, {
      action: 'remove-viewer',
      roomId,
      viewerId,
      expectedRoomRevision: await roomRevision(roomId),
    });
    expect(await count(managerId, roomId, buyerId)).toBe(0);
  });

  it('gives the same refusal for nonexistent viewer as for viewer in another room', async () => {
    const otherViewerId = await seedViewerWithRoomGrant(
      otherRoomId,
      ownerId,
      'other.counterparty.viewer',
    );
    const unknownViewerId = createOpaqueId();

    const otherViewerRefusal = await counterparties(managerId, {
      action: 'remove-viewer',
      roomId,
      viewerId: otherViewerId,
      expectedRoomRevision: await roomRevision(roomId),
    });
    expect(otherViewerRefusal.statusCode).toBe(409);

    const unknownViewerRefusal = await counterparties(managerId, {
      action: 'remove-viewer',
      roomId,
      viewerId: unknownViewerId,
      expectedRoomRevision: await roomRevision(roomId),
    });
    expect(unknownViewerRefusal.statusCode).toBe(409);
    expect(otherViewerRefusal.json()).toStrictEqual(unknownViewerRefusal.json());
  });

  it('refuses nonexistent room for Owner on counterparty operations', async () => {
    const unknownRoom = createOpaqueId();
    const ownerList = await roster(ownerId, unknownRoom);
    expect(ownerList.statusCode).toBe(403);

    const ownerRemove = await counterparties(ownerId, {
      action: 'remove-viewer',
      roomId: unknownRoom,
      viewerId,
      expectedRoomRevision: 1,
    });
    expect(ownerRemove.statusCode).toBe(403);
  });
});

describe('audit and protocol invariants', () => {
  /*
   * INVARIANT 14, PROVEN BY BREAKING IT. A malformed audit id fails the `audit_event.id` CHECK,
   * which is the only way from a test to make the audit insert fail while the mutation would
   * otherwise succeed. If the mutation and its audit row were separate commits, the placement
   * would survive; because they are one transaction, nothing survives.
   */
  it('rolls the mutation back when its audit row cannot be written', async () => {
    const buyerId = await createdCounterparty(`Buyer ${createOpaqueId().slice(0, 8)}`);
    const before = await roomRevision(roomId);
    await expect(
      databasePool.query('SELECT assign_viewer_counterparty($1,$2,$3,$4,$5,$6,$7,$8)', [
        createOpaqueId(),
        buyerId,
        viewerId,
        roomId,
        managerId,
        before,
        'not a valid audit id',
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '23514' });

    /* No placement, and the room revision the function had already bumped is back. */
    expect(
      (
        await migrationPool.query(
          "SELECT 1 FROM counterparty_viewer WHERE counterparty_id=$1 AND state='active'",
          [buyerId],
        )
      ).rowCount,
    ).toBe(0);
    expect(await roomRevision(roomId)).toBe(before);
  });

  it('keeps every counterparty audit detail free of personal data', async () => {
    const required = [
      'participant.counterparty.create',
      'participant.counterparty.assign',
      'participant.counterparty.remove',
    ];
    const events = (
      await migrationPool.query<{
        event_type: string;
        result: string;
        detail: Record<string, unknown> | null;
      }>('SELECT event_type, result, detail FROM audit_event WHERE room_id=$1', [roomId])
    ).rows;

    /* Each kind this suite's work produces must be present, so the sweep below cannot pass by
       finding nothing to sweep. */
    const seen = new Set(events.map((event) => event.event_type));
    for (const type of required) expect(seen).toContain(type);

    for (const event of events.filter((event) => required.includes(event.event_type))) {
      expect(event.result).toBe('success');
      const detail = JSON.stringify(event.detail ?? {});
      /* An address, a raw IP, or an object key would each be a §20.3 violation. */
      expect(detail).not.toMatch(/@/);
      expect(detail).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
      expect(detail).not.toMatch(/s3:\/\/|\/var\/|deletion-markers/);
    }
  });

  it('enforces closed union schemas at HTTP boundary (rejecting mixed or unknown fields with 400)', async () => {
    const mixedPolicy = await policies(managerId, {
      action: 'room-download',
      roomId,
      policy: 'allow',
      expectedRoomRevision: await roomRevision(roomId),
      documentId,
    });
    expect(mixedPolicy.statusCode).toBe(400);

    const unknownPolicyAction = await policies(managerId, { action: 'unknown-action', roomId });
    expect(unknownPolicyAction.statusCode).toBe(400);

    const mixedCounterparty = await counterparties(managerId, {
      action: 'create',
      roomId,
      name: 'Valid Name',
      expectedRoomRevision: await roomRevision(roomId),
      viewerId,
    });
    expect(mixedCounterparty.statusCode).toBe(400);

    const unknownCounterpartyAction = await counterparties(managerId, {
      action: 'unknown-action',
      roomId,
    });
    expect(unknownCounterpartyAction.statusCode).toBe(400);
  });

  it('returns uniform 403 error body for unauthorized callers', async () => {
    const policyRefusal = await policies(contributorId, {
      action: 'room-download',
      roomId,
      policy: 'allow',
      expectedRoomRevision: await roomRevision(roomId),
    });
    expect(policyRefusal.statusCode).toBe(403);
    expect(policyRefusal.json()).toStrictEqual({
      error: { code: 'FORBIDDEN', message: 'This action is not available to you.' },
    });

    const cpRefusal = await counterparties(contributorId, {
      action: 'create',
      roomId,
      name: 'Test CP',
      expectedRoomRevision: await roomRevision(roomId),
    });
    expect(cpRefusal.statusCode).toBe(403);
    expect(cpRefusal.json()).toStrictEqual({
      error: { code: 'FORBIDDEN', message: 'This action is not available to you.' },
    });
  });

  it('enforces CSRF protection on both policy and counterparty mutations', async () => {
    const policyNoCsrf = await policies(
      managerId,
      {
        action: 'room-download',
        roomId,
        policy: 'deny',
        expectedRoomRevision: await roomRevision(roomId),
      },
      false,
    );
    expect(policyNoCsrf.statusCode).toBe(403);

    const cpNoCsrf = await counterparties(
      managerId,
      {
        action: 'create',
        roomId,
        name: 'No CSRF',
        expectedRoomRevision: await roomRevision(roomId),
      },
      false,
    );
    expect(cpNoCsrf.statusCode).toBe(403);
  });
});
