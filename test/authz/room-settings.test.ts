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
  seedViewerWithRoomGrant,
  staffRoom,
} from './support/room-fixture.ts';

let ownerId = '';
let adminId = '';
let managerId = '';
let contributorId = '';
let plainMemberId = '';
let roomId = '';

beforeAll(async () => {
  ownerId = await resetRoomSchema('Room settings');
  adminId = await seedMember('admin', 'settings.admin');
  managerId = await seedMember('member', 'settings.manager');
  contributorId = await seedMember('member', 'settings.contributor');
  plainMemberId = await seedMember('member', 'settings.plain');
  roomId = await seedRoom(ownerId, 'Settings room');
  await staffRoom(managerId, roomId, 'manager', ownerId);
  await staffRoom(contributorId, roomId, 'contributor', ownerId);
});
afterAll(closeRoutePools);

interface SettingsRow {
  readonly state: string;
  readonly download_policy: string | null;
  readonly installation_download_policy: string;
  readonly purge_id: string | null;
  readonly capabilities: Record<string, boolean>;
}

async function settingsAs(memberId: string, id = roomId): Promise<SettingsRow> {
  const row = (
    await databasePool.query<SettingsRow>('SELECT * FROM read_room_settings($1,$2)', [
      memberId,
      id,
    ])
  ).rows[0];
  if (row === undefined) throw new Error('no settings row');
  return row;
}

async function setState(id: string, state: 'draft' | 'published' | 'archived'): Promise<void> {
  await migrationPool.query('UPDATE room SET state=$2,revision=revision+1 WHERE id=$1', [
    id,
    state,
  ]);
}

async function schedulePurge(id: string): Promise<string> {
  const purgeId = createOpaqueId();
  await databasePool.query('SELECT schedule_room_purge($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [
    purgeId,
    ownerId,
    id,
    new Date(),
    await roomRevision(id),
    'SCHEDULE ROOM PURGE',
    `system/deletion-markers/v1/${id}/${purgeId}.json`,
    createOpaqueId(),
    createOpaqueId(),
    createCorrelationId(),
  ]);
  return purgeId;
}

async function cancelPurge(purgeId: string): Promise<void> {
  await databasePool.query('SELECT cancel_room_purge($1,$2,$3,$4,$5)', [
    purgeId,
    ownerId,
    'CANCEL ROOM PURGE',
    createOpaqueId(),
    createCorrelationId(),
  ]);
}

describe('read_room_settings', () => {
  it.each([['Owner'], ['Admin'], ['Room Manager']])('answers the %s', async (who) => {
    const actor = { Owner: ownerId, Admin: adminId, 'Room Manager': managerId }[who] ?? '';
    const row = await settingsAs(actor);
    expect(row).toMatchObject({
      state: 'draft',
      download_policy: null,
      installation_download_policy: 'deny',
      purge_id: null,
    });
  });

  it('refuses a Contributor, a plain member, and an unknown room alike', async () => {
    await expect(settingsAs(contributorId)).rejects.toMatchObject({ code: '42501' });
    await expect(settingsAs(plainMemberId)).rejects.toMatchObject({ code: '42501' });
    await expect(settingsAs(ownerId, createOpaqueId())).rejects.toMatchObject({
      code: '42501',
    });
  });
});

describe('room_settings_capabilities', () => {
  it('offers a Manager archiving but not publication before any structure is published', async () => {
    expect((await settingsAs(managerId)).capabilities).toStrictEqual({
      publish: false,
      archive: true,
      returnToDraft: false,
      setRetention: false,
      schedulePurge: false,
      cancelPurge: false,
    });
  });

  it('offers the Owner retention while draft, and publication once structure is published', async () => {
    const id = await seedRoom(ownerId, 'Publishable');
    await migrationPool.query('UPDATE room SET published_revision=1 WHERE id=$1', [id]);
    expect((await settingsAs(ownerId, id)).capabilities).toMatchObject({
      publish: true,
      setRetention: true,
    });
    expect((await settingsAs(adminId, id)).capabilities).toMatchObject({
      publish: true,
      setRetention: false,
    });
  });

  it('offers purge on an archived room, then only cancellation while it is live', async () => {
    const id = await seedRoom(ownerId, 'Archived');
    await setState(id, 'archived');
    expect((await settingsAs(ownerId, id)).capabilities).toMatchObject({
      schedulePurge: true,
      cancelPurge: false,
      returnToDraft: true,
    });
    const purgeId = await schedulePurge(id);
    expect((await settingsAs(ownerId, id)).capabilities).toMatchObject({
      schedulePurge: false,
      cancelPurge: true,
      returnToDraft: false,
    });
    expect((await settingsAs(adminId, id)).capabilities).toMatchObject({
      schedulePurge: false,
      cancelPurge: false,
    });
    await cancelPurge(purgeId);
    expect((await settingsAs(ownerId, id)).capabilities).toMatchObject({ schedulePurge: true });
  });

  /*
   * The purge keys against their functions, across every arrangement that decides them: who
   * the actor is, what state the room is in, and what the room's purge history holds. A
   * capability that promised more than its function accepts would offer a control whose use
   * is then refused, which is exactly what mirroring forbids.
   *
   * Each call runs in a transaction that is rolled back, so asking whether a function accepts
   * does not change what the next case sees.
   */
  async function accepts(
    call: 'schedule' | 'cancel',
    actorId: string,
    id: string,
    purgeId: string | null,
  ): Promise<boolean> {
    const client = await databasePool.connect();
    try {
      await client.query('BEGIN');
      if (call === 'cancel')
        return purgeId === null
          ? false
          : await client
              .query('SELECT cancel_room_purge($1,$2,$3,$4,$5)', [
                purgeId,
                actorId,
                'CANCEL ROOM PURGE',
                createOpaqueId(),
                createCorrelationId(),
              ])
              .then(
                () => true,
                () => false,
              );
      const fresh = createOpaqueId();
      return await client
        .query('SELECT schedule_room_purge($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [
          fresh,
          actorId,
          id,
          new Date(),
          await roomRevision(id),
          'SCHEDULE ROOM PURGE',
          `system/deletion-markers/v1/${id}/${fresh}.json`,
          createOpaqueId(),
          createOpaqueId(),
          createCorrelationId(),
        ])
        .then(
          () => true,
          () => false,
        );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  it.each([
    ['a draft room, no purge', 'draft', 'none'],
    ['an archived room, no purge', 'archived', 'none'],
    ['an archived room with a scheduled purge', 'archived', 'scheduled'],
    ['an archived room with a cancelled purge', 'archived', 'cancelled'],
    ['an archived room whose purge is past its window', 'archived', 'lapsed'],
    ['an archived room whose purge is marker_pending', 'archived', 'marker_pending'],
    ['an archived room whose purge is purging', 'archived', 'purging'],
    ['an archived room whose purge failed', 'archived', 'failed'],
  ] as const)('mirrors the purge functions for %s', async (label, state, history) => {
    const id = await seedRoom(ownerId, `Purge mirror ${label}`);
    await staffRoom(managerId, id, 'manager', ownerId);
    if (state === 'archived') await setState(id, 'archived');
    let purgeId: string | null = null;
    if (history !== 'none') {
      purgeId = await schedulePurge(id);
      if (history === 'cancelled') await cancelPurge(purgeId);
      else if (history === 'lapsed')
        /* Past its cancellation window. The CHECK ties purge_after to scheduled_at, so both
             move together rather than leaving an impossible row behind. */
        await migrationPool.query(
          `UPDATE room_purge SET scheduled_at=statement_timestamp()-interval '31 days',
                 purge_after=statement_timestamp()-interval '1 day' WHERE id=$1`,
          [purgeId],
        );
      else if (history !== 'scheduled')
        await migrationPool.query('UPDATE room_purge SET state=$2 WHERE id=$1', [
          purgeId,
          history,
        ]);
    }
    /* Owner and a non-Owner Manager: authority is half of what each key decides. */
    for (const actor of [ownerId, managerId]) {
      const offered = (await settingsAs(actor, id)).capabilities;
      expect(offered['schedulePurge']).toBe(await accepts('schedule', actor, id, purgeId));
      expect(offered['cancelPurge']).toBe(await accepts('cancel', actor, id, purgeId));
    }
  });

  it('mirrors apply_audit_retention: setRetention is true exactly when the call is accepted', async () => {
    for (const actor of [ownerId, adminId, managerId]) {
      const id = await seedRoom(ownerId, `Retention ${actor.slice(0, 6)}`);
      await staffRoom(managerId, id, 'manager', ownerId);
      const offered = (await settingsAs(actor, id)).capabilities['setRetention'];
      const accepted = await databasePool
        .query('SELECT apply_audit_retention($1,$2,$3,$4,$5,$6,$7,$8)', [
          actor,
          id,
          5,
          new Date(),
          await roomRevision(id),
          'SET AUDIT RETENTION TO 5 YEARS',
          createOpaqueId(),
          createCorrelationId(),
        ])
        .then(
          () => true,
          () => false,
        );
      expect(accepted).toBe(offered);
    }
  });
});

describe('GET /api/rooms/settings', () => {
  it('returns settings and the document download overrides to a Room Manager', async () => {
    const documentId = createOpaqueId();
    await migrationPool.query(
      'INSERT INTO document(id,room_id,display_title,created_by) VALUES($1,$2,$3,$4)',
      [documentId, roomId, 'Management accounts', managerId],
    );
    await databasePool.query('SELECT create_document_entry($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
      createOpaqueId(),
      documentId,
      null,
      'Management accounts',
      1,
      managerId,
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
      managerId,
      documentId,
      'allow',
      2,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    const instance = await app();
    const response = await instance.inject({
      method: 'GET',
      url: `/api/rooms/settings?roomId=${roomId}`,
      headers: headers(await memberSession(managerId), false),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      settings: Record<string, unknown>;
      downloadOverrides: unknown[];
    }>();
    expect(body.settings).toMatchObject({
      roomId,
      state: 'draft',
      downloadPolicy: null,
      installationDownloadPolicy: 'deny',
      purge: null,
      auditRetentionYears: 7,
    });
    expect(body.downloadOverrides).toStrictEqual([{ documentId, policy: 'allow' }]);
    await instance.close();
  });

  it('refuses a Contributor with the uniform 403', async () => {
    const instance = await app();
    const response = await instance.inject({
      method: 'GET',
      url: `/api/rooms/settings?roomId=${roomId}`,
      headers: headers(await memberSession(contributorId), false),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toStrictEqual({
      error: { code: 'FORBIDDEN', message: 'This action is not available to you.' },
    });
    await instance.close();
  });
});

describe('room visibility', () => {
  let visibleRoomId = '';

  async function visibility(
    memberId: string,
    payload: Record<string, unknown>,
    authenticatedAt?: Date,
  ) {
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/rooms/visibility',
      headers: headers(await memberSession(memberId, authenticatedAt)),
      payload: { roomId: visibleRoomId, ...payload },
    });
    await instance.close();
    return response;
  }
  const stale = () => new Date(Date.now() - 30 * 60_000);
  const roomState = async () =>
    (
      await migrationPool.query<{ state: string }>('SELECT state FROM room WHERE id=$1', [
        visibleRoomId,
      ])
    ).rows[0]?.state;

  beforeAll(async () => {
    visibleRoomId = await seedRoom(ownerId, 'Visibility room');
    await staffRoom(managerId, visibleRoomId, 'manager', ownerId);
    await staffRoom(contributorId, visibleRoomId, 'contributor', ownerId);
    await migrationPool.query('UPDATE room SET published_revision=1 WHERE id=$1', [
      visibleRoomId,
    ]);
    await seedViewerWithRoomGrant(visibleRoomId, ownerId, 'visibility.viewer');
  });

  it('previews publication with the viewers who will gain access', async () => {
    const response = await visibility(managerId, { action: 'dry-run', state: 'published' });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ impact: unknown }>().impact).toStrictEqual({
      roomId: visibleRoomId,
      currentState: 'draft',
      proposedState: 'published',
      viewerCount: 1,
      publishedDocumentCount: 0,
      requiresFreshAuthentication: true,
      expectedRevision: await roomRevision(visibleRoomId),
      confirmation: 'PUBLISH ROOM',
    });
  });

  it('refuses a Contributor as forbidden, even on a stale sign-in', async () => {
    for (const payload of [
      { action: 'dry-run', state: 'published' },
      {
        action: 'apply',
        state: 'published',
        expectedRevision: 1,
        confirmation: 'PUBLISH ROOM',
      },
    ]) {
      const response = await visibility(contributorId, payload, stale());
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    }
  });

  it('asks a Manager on a stale sign-in to sign in again before publishing', async () => {
    const response = await visibility(
      managerId,
      {
        action: 'apply',
        state: 'published',
        expectedRevision: await roomRevision(visibleRoomId),
        confirmation: 'PUBLISH ROOM',
      },
      stale(),
    );
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'FRESH_AUTHENTICATION_REQUIRED' } });
  });

  it('refuses a mistyped phrase and a stale revision', async () => {
    const revision = await roomRevision(visibleRoomId);
    expect(
      (
        await visibility(managerId, {
          action: 'apply',
          state: 'published',
          expectedRevision: revision,
          confirmation: 'publish room',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await visibility(managerId, {
          action: 'apply',
          state: 'published',
          expectedRevision: revision - 1,
          confirmation: 'PUBLISH ROOM',
        })
      ).statusCode,
    ).toBe(409);
    expect(await roomState()).toBe('draft');
  });

  it('publishes on a fresh sign-in with the phrase, and audits it', async () => {
    const response = await visibility(managerId, {
      action: 'apply',
      state: 'published',
      expectedRevision: await roomRevision(visibleRoomId),
      confirmation: 'PUBLISH ROOM',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({ revision: await roomRevision(visibleRoomId) });
    expect(await roomState()).toBe('published');
    expect(
      (
        await migrationPool.query(
          "SELECT actor_id FROM audit_event WHERE event_type='room.state' AND room_id=$1 AND reason_code='ROOM_PUBLISHED'",
          [visibleRoomId],
        )
      ).rows,
    ).toEqual([{ actor_id: managerId }]);
  });

  it('returns to draft on a stale sign-in with no dry run and no phrase', async () => {
    const response = await visibility(
      managerId,
      { action: 'apply', state: 'draft', expectedRevision: await roomRevision(visibleRoomId) },
      stale(),
    );
    expect(response.statusCode).toBe(200);
    expect(await roomState()).toBe('draft');
  });

  it('refuses a phrase on the kill switch, and a change to the current state', async () => {
    const revision = await roomRevision(visibleRoomId);
    expect(
      (
        await visibility(managerId, {
          action: 'apply',
          state: 'draft',
          expectedRevision: revision,
          confirmation: 'ARCHIVE ROOM',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await visibility(managerId, {
          action: 'apply',
          state: 'draft',
          expectedRevision: revision,
        })
      ).statusCode,
    ).toBe(409);
  });

  it('archives on a stale sign-in with its phrase, and stays archived while a purge is live', async () => {
    const archived = await visibility(
      managerId,
      {
        action: 'apply',
        state: 'archived',
        expectedRevision: await roomRevision(visibleRoomId),
        confirmation: 'ARCHIVE ROOM',
      },
      stale(),
    );
    expect(archived.statusCode).toBe(200);
    const purgeId = await schedulePurge(visibleRoomId);
    const pinned = await visibility(managerId, {
      action: 'apply',
      state: 'draft',
      expectedRevision: await roomRevision(visibleRoomId),
    });
    expect(pinned.statusCode).toBe(409);
    await cancelPurge(purgeId);
    expect(
      (
        await visibility(managerId, {
          action: 'apply',
          state: 'draft',
          expectedRevision: await roomRevision(visibleRoomId),
        })
      ).statusCode,
    ).toBe(200);
  });

  it('leaves the runtime no direct path to change_room_state', async () => {
    await expect(
      databasePool.query('SELECT change_room_state($1,$2,$3,$4,$5,$6)', [
        visibleRoomId,
        'published',
        managerId,
        await roomRevision(visibleRoomId),
        createOpaqueId(),
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('visibility capabilities mirror apply_room_visibility', () => {
  /** Whether apply accepts, decided inside a transaction that is always rolled back. */
  async function accepted(
    actorId: string,
    id: string,
    state: 'draft' | 'published' | 'archived',
  ) {
    const client = await databasePool.connect();
    try {
      await client.query('BEGIN');
      const revision = (
        await client.query<{ revision: number }>(
          'SELECT revision FROM read_member_room($1,$2)',
          [actorId, id],
        )
      ).rows[0]?.revision;
      const confirmation = { draft: null, published: 'PUBLISH ROOM', archived: 'ARCHIVE ROOM' }[
        state
      ];
      return await client
        .query('SELECT apply_room_visibility($1,$2,$3,$4,$5,$6,$7,$8)', [
          actorId,
          id,
          state,
          revision,
          new Date(),
          confirmation,
          createOpaqueId(),
          createCorrelationId(),
        ])
        .then(
          () => true,
          () => false,
        );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  it.each([
    ['a never-published draft', 'draft', 0, false],
    ['a publishable draft', 'draft', 1, false],
    ['a published room', 'published', 1, false],
    ['an archived room', 'archived', 1, false],
    ['an archived room with a live purge', 'archived', 1, true],
  ] as const)('for a Manager in %s', async (label, state, publishedRevision, livePurge) => {
    const id = await seedRoom(ownerId, `Mirror ${label}`);
    await staffRoom(managerId, id, 'manager', ownerId);
    await migrationPool.query('UPDATE room SET published_revision=$2 WHERE id=$1', [
      id,
      publishedRevision,
    ]);
    if (state !== 'draft') await setState(id, state);
    if (livePurge) await schedulePurge(id);
    const offered = (await settingsAs(managerId, id)).capabilities;
    expect(offered['publish']).toBe(await accepted(managerId, id, 'published'));
    expect(offered['archive']).toBe(await accepted(managerId, id, 'archived'));
    expect(offered['returnToDraft']).toBe(await accepted(managerId, id, 'draft'));
  });
});
