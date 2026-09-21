import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import {
  app,
  closeRoutePools,
  databasePool,
  headers,
  memberSession,
  migrationPool,
} from './support/route-fixture.ts';
import {
  resetRoomSchema,
  roomRevision,
  seedMember,
  seedRoom,
  staffRoom,
} from './support/room-fixture.ts';

let ownerId = '';
let adminId = '';
let contributorId = '';
let plainMemberId = '';
let staffedRoomId = '';
let otherRoomId = '';

beforeAll(async () => {
  ownerId = await resetRoomSchema('Room administration');
  adminId = await seedMember('admin', 'room.admin');
  contributorId = await seedMember('member', 'room.contributor');
  plainMemberId = await seedMember('member', 'room.plain');
  staffedRoomId = await seedRoom(ownerId, 'Staffed room');
  otherRoomId = await seedRoom(ownerId, 'Unstaffed room');
  await staffRoom(contributorId, staffedRoomId, 'contributor', ownerId);
});
afterAll(closeRoutePools);

function createRoomAs(actorId: string, title: string, description = '') {
  return databasePool.query('SELECT create_room($1,$2,$3,$4,$5,$6)', [
    createOpaqueId(),
    title,
    description,
    actorId,
    createOpaqueId(),
    createCorrelationId(),
  ]);
}

describe('create_room', () => {
  it('admits an Admin and an Owner', async () => {
    await expect(createRoomAs(adminId, 'Series B')).resolves.toBeDefined();
    await expect(createRoomAs(ownerId, 'Series C')).resolves.toBeDefined();
  });

  it('refuses a plain member', async () => {
    await expect(createRoomAs(plainMemberId, 'Refused')).rejects.toMatchObject({
      code: '42501',
    });
  });

  it.each([
    ['   '],
    ['\u00A0\u00A0'],
    ['\u2003'],
    ['\u3000'],
    ['\u00A0 \u2003\u3000'],
    ['Two\nlines'],
    ['Two\rlines'],
    ['Tab\there'],
    ['Line\u0085break'],
    ['Line\u2028break'],
    ['Line\u2029break'],
    ['Bell\u0007'],
    ['Café'],
    ['x'.repeat(201)],
  ])('refuses the title %j as invalid', async (title) => {
    await expect(createRoomAs(adminId, title)).rejects.toMatchObject({ code: '22023' });
  });

  it.each([['x'.repeat(200)], ['資料 A'], ['Project\u00A0Atlas']])(
    'accepts the valid title %j',
    async (title) => {
      await expect(createRoomAs(adminId, title)).resolves.toBeDefined();
    },
  );

  it('refuses a description with a control character', async () => {
    await expect(createRoomAs(adminId, 'Fine', 'bad\u0007')).rejects.toMatchObject({
      code: '22023',
    });
  });
});

describe('POST /api/rooms', () => {
  it('creates a draft room, answers 201, and audits the creation', async () => {
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: headers(await memberSession(adminId)),
      payload: { title: 'Project Atlas', description: 'Sell-side room' },
    });
    expect(response.statusCode).toBe(201);
    const { roomId } = response.json<{ roomId: string }>();
    expect(
      (await migrationPool.query('SELECT title,state FROM room WHERE id=$1', [roomId])).rows[0],
    ).toEqual({ title: 'Project Atlas', state: 'draft' });
    expect(
      (
        await migrationPool.query(
          "SELECT actor_id,reason_code FROM audit_event WHERE event_type='room.create' AND resource_id=$1",
          [roomId],
        )
      ).rows,
    ).toEqual([{ actor_id: adminId, reason_code: 'ROOM_CREATED' }]);
    await instance.close();
  });

  it('answers an unusable title with 400, never 500', async () => {
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: headers(await memberSession(adminId)),
      payload: { title: '   ', description: '' },
    });
    expect(response.statusCode).toBe(400);
    await instance.close();
  });

  it('refuses a plain member with the uniform 403', async () => {
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: headers(await memberSession(plainMemberId)),
      payload: { title: 'Refused', description: '' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toStrictEqual({
      error: { code: 'FORBIDDEN', message: 'This action is not available to you.' },
    });
    await instance.close();
  });

  it('requires the CSRF header', async () => {
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: headers(await memberSession(adminId), false),
      payload: { title: 'No token', description: '' },
    });
    expect(response.statusCode).toBe(403);
    await instance.close();
  });
});

describe('GET /api/rooms?roomId=', () => {
  async function readOne(memberId: string, roomId: string) {
    const instance = await app();
    const response = await instance.inject({
      method: 'GET',
      url: `/api/rooms?roomId=${roomId}`,
      headers: headers(await memberSession(memberId), false),
    });
    await instance.close();
    return response;
  }

  it('returns a staffed Contributor their room, explained as an assignment', async () => {
    const response = await readOne(contributorId, staffedRoomId);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ rooms: unknown[] }>().rooms).toEqual([
      expect.objectContaining({
        roomId: staffedRoomId,
        accessSource: 'assignment',
        roomRole: 'contributor',
        canPublish: false,
      }),
    ]);
  });

  it('returns an Admin any room, explained by the organization role', async () => {
    const response = await readOne(adminId, otherRoomId);
    expect(response.json<{ rooms: unknown[] }>().rooms).toEqual([
      expect.objectContaining({
        roomId: otherRoomId,
        accessSource: 'global_role',
        canPublish: true,
      }),
    ]);
  });

  it('answers an unreachable room and an unknown id identically', async () => {
    const unreachable = await readOne(contributorId, otherRoomId);
    const unknown = await readOne(contributorId, createOpaqueId());
    expect(unreachable.statusCode).toBe(200);
    expect(unreachable.json()).toStrictEqual({ rooms: [] });
    expect(unknown.json()).toStrictEqual({ rooms: [] });
  });

  it('refuses a roomId combined with a cursor', async () => {
    const instance = await app();
    const response = await instance.inject({
      method: 'GET',
      url: `/api/rooms?roomId=${staffedRoomId}&afterTitle=A&afterRoomId=${staffedRoomId}`,
      headers: headers(await memberSession(adminId), false),
    });
    expect(response.statusCode).toBe(400);
    await instance.close();
  });
});

describe('purge safety', () => {
  let roomId = '';

  /*
   * The product path, so the pin is proven where a member would meet it. Nothing here writes
   * `room.state` directly except the one case that says why it does.
   */
  function changeState(
    id: string,
    state: string,
    revision: number,
    confirmation: string | null,
  ) {
    return databasePool.query('SELECT apply_room_visibility($1,$2,$3,$4,$5,$6,$7,$8)', [
      ownerId,
      id,
      state,
      revision,
      new Date(),
      confirmation,
      createOpaqueId(),
      createCorrelationId(),
    ]);
  }

  async function archive(id: string): Promise<void> {
    await changeState(id, 'archived', await roomRevision(id), 'ARCHIVE ROOM');
  }

  async function schedule(id: string, confirmation = 'SCHEDULE ROOM PURGE'): Promise<string> {
    const purgeId = createOpaqueId();
    await databasePool.query('SELECT schedule_room_purge($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [
      purgeId,
      ownerId,
      id,
      new Date(),
      await roomRevision(id),
      confirmation,
      `system/deletion-markers/v1/${id}/${purgeId}.json`,
      createOpaqueId(),
      createOpaqueId(),
      createCorrelationId(),
    ]);
    return purgeId;
  }

  async function cancel(purgeId: string): Promise<void> {
    await databasePool.query('SELECT cancel_room_purge($1,$2,$3,$4,$5)', [
      purgeId,
      ownerId,
      'CANCEL ROOM PURGE',
      createOpaqueId(),
      createCorrelationId(),
    ]);
  }

  beforeAll(async () => {
    roomId = await seedRoom(ownerId, 'Purge candidate');
    await archive(roomId);
  });

  it('offers a phrase a person can type', async () => {
    const impact = (
      await databasePool.query<{ impact: { confirmation: string } }>(
        'SELECT dry_run_room_purge($1,$2) AS impact',
        [ownerId, roomId],
      )
    ).rows[0]?.impact;
    expect(impact?.confirmation).toBe('SCHEDULE ROOM PURGE');
  });

  it('pins the room to archived while the purge is live, and frees it on cancellation', async () => {
    const purgeId = await schedule(roomId);
    const pinned = await roomRevision(roomId);
    await expect(changeState(roomId, 'draft', pinned, null)).rejects.toMatchObject({
      code: '55000',
    });
    /* The revision did not move, so the refusal happened before the write. */
    expect(await roomRevision(roomId)).toBe(pinned);

    /*
     * The rule is ANY departure from archived, not only the one the product offers. Asserted
     * at the table, because `change_room_state` refuses 'published' for a room with no
     * published revision on its own rule, so that request never reaches the trigger.
     */
    await expect(
      migrationPool.query("UPDATE room SET state='published' WHERE id=$1", [roomId]),
    ).rejects.toMatchObject({ code: '55000' });

    await expect(
      databasePool.query('SELECT dry_run_room_purge($1,$2)', [ownerId, roomId]),
    ).rejects.toMatchObject({ code: '55000' });

    await cancel(purgeId);
    await changeState(roomId, 'draft', await roomRevision(roomId), null);
    expect(
      (await migrationPool.query('SELECT state FROM room WHERE id=$1', [roomId])).rows[0],
    ).toEqual({ state: 'draft' });
  });

  /*
   * A purge that reached a terminal failure does NOT pin its room, and that is deliberate:
   * cancellation is the only release and `cancel_room_purge` releases only a `scheduled`
   * purge, so pinning here would strand the room in archived with no way back. The room is
   * released; the failed purge row remains as evidence and the index below still refuses a
   * second live purge.
   */
  it('releases the room when a purge ended in failure, which cancellation cannot undo', async () => {
    const held = await seedRoom(ownerId, 'Failed purge');
    await archive(held);
    const purgeId = await schedule(held);
    await migrationPool.query("UPDATE room_purge SET state='failed' WHERE id=$1", [purgeId]);
    await expect(
      databasePool.query('SELECT cancel_room_purge($1,$2,$3,$4,$5)', [
        purgeId,
        ownerId,
        'CANCEL ROOM PURGE',
        createOpaqueId(),
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '55000' });
    await changeState(held, 'draft', await roomRevision(held), null);
    expect(
      (await migrationPool.query('SELECT state FROM room WHERE id=$1', [held])).rows[0],
    ).toEqual({ state: 'draft' });
  });

  it('lets a cancelled purge be scheduled again', async () => {
    const again = await seedRoom(ownerId, 'Rescheduled');
    await archive(again);
    await cancel(await schedule(again));
    const second = await schedule(again);
    expect(
      (
        await migrationPool.query(
          'SELECT state FROM room_purge WHERE room_id=$1 ORDER BY scheduled_at',
          [again],
        )
      ).rows.map(({ state }: { state: string }) => state),
    ).toEqual(['cancelled', 'scheduled']);
    await cancel(second);
  });
});

describe('document revision in the working structure', () => {
  it('reports the revision update_document_metadata compares, after they diverge', async () => {
    const roomId = await seedRoom(ownerId, 'Revision room');
    const entryId = createOpaqueId();
    const documentId = createOpaqueId();
    await migrationPool.query(
      'INSERT INTO document(id,room_id,display_title,created_by) VALUES($1,$2,$3,$4)',
      [documentId, roomId, 'Teaser', ownerId],
    );
    await databasePool.query('SELECT create_document_entry($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
      entryId,
      documentId,
      null,
      'Teaser',
      1,
      ownerId,
      (
        await migrationPool.query<{ working_revision: number }>(
          'SELECT working_revision FROM room WHERE id=$1',
          [roomId],
        )
      ).rows[0]?.working_revision,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    await databasePool.query('SELECT set_document_download_policy($1,$2,$3,$4,$5,$6)', [
      ownerId,
      documentId,
      'allow',
      2,
      createOpaqueId(),
      createCorrelationId(),
    ]);

    const entry = (
      await databasePool.query<{ revision: number; document_revision: number | null }>(
        'SELECT revision,document_revision FROM read_member_working_structure($1,$2) WHERE entry_id=$3',
        [ownerId, roomId, entryId],
      )
    ).rows[0];
    /*
     * The two counters must not be the same number, which is the whole point of carrying the
     * second one: a download policy change moves the document and leaves the entry alone, so
     * a client that sent the entry's revision as the document's would be refused as stale.
     * Compared against the tables rather than to literals, so the case says what it means.
     */
    const counters = (
      await migrationPool.query<{ entry_revision: number; document_revision: number }>(
        `SELECT e.revision AS entry_revision, d.revision AS document_revision
           FROM working_structure_entry e JOIN document d ON d.id=e.document_id
          WHERE e.id=$1`,
        [entryId],
      )
    ).rows[0];
    expect(entry).toEqual({
      revision: counters?.entry_revision,
      document_revision: counters?.document_revision,
    });
    expect(entry?.revision).not.toBe(entry?.document_revision);

    /* A folder has no document, so its column is null rather than a borrowed number. */
    await databasePool.query('SELECT create_folder_entry($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [
      createOpaqueId(),
      roomId,
      null,
      'Financials',
      '',
      2,
      ownerId,
      (
        await migrationPool.query<{ working_revision: number }>(
          'SELECT working_revision FROM room WHERE id=$1',
          [roomId],
        )
      ).rows[0]?.working_revision,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    expect(
      (
        await databasePool.query<{ document_revision: number | null }>(
          `SELECT document_revision FROM read_member_working_structure($1,$2)
            WHERE resource_kind='folder'`,
          [ownerId, roomId],
        )
      ).rows,
    ).toEqual([{ document_revision: null }]);

    const working = (
      await migrationPool.query<{ working_revision: number }>(
        'SELECT working_revision FROM room WHERE id=$1',
        [roomId],
      )
    ).rows[0]?.working_revision;
    await expect(
      databasePool.query('SELECT * FROM update_document_metadata($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
        documentId,
        'Teaser v2',
        '',
        null,
        ownerId,
        entry?.document_revision,
        working,
        createOpaqueId(),
        createCorrelationId(),
      ]),
    ).resolves.toBeDefined();
  });
});

/**
 * §20.3 ACROSS EVERY EVENT THIS MILESTONE WRITES, not one suite's subset.
 *
 * `docs/room-administration-http-contract.md` states that no detail field carries an email, a
 * title, a token or an object key. That is a compliance claim, so it is asserted over whatever
 * the whole suite produced rather than trusted per function: a new event type added later is
 * covered the moment any case exercises it.
 */
describe('audit detail carries no personal data', () => {
  it('holds for every event room administration writes', async () => {
    const rows = (
      await migrationPool.query<{ event_type: string; detail: string | null }>(
        `SELECT event_type, detail::text AS detail FROM audit_event
          WHERE event_type IN ('room.create','room.state','download.policy','grant.default_expiry',
                               'audit.retention','room.purge','participant.counterparty.create',
                               'participant.counterparty.assign','participant.counterparty.remove')`,
      )
    ).rows;
    /* Something must have been produced, or the sweep below proves nothing. */
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const detail = row.detail ?? '{}';
      expect(detail, row.event_type).not.toMatch(/@/);
      expect(detail, row.event_type).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
      expect(detail, row.event_type).not.toMatch(/s3:\/\/|deletion-markers|\/var\//);
    }
  });
});
