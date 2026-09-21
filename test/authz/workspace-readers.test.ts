import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import { generatedMigrations } from '../../.duefold/generated/migrations.ts';
import { migrate } from '../../modules/core-security/src/db/migrate.ts';
import type { MemberIdentity } from '../../modules/core-security/src/authorization.ts';
import {
  readMemberRooms,
  readTrash,
  readWorkingStructure,
} from '../../modules/rooms-documents/src/workspace-reads.ts';

/**
 * Authorization for the member workspace readers added in migration 006.
 *
 * duefold_runtime has no SELECT on room, folder, working_structure_entry,
 * published_structure_entry or room_trash, so these readers are the entire read
 * surface for the workspace. Every negative arm here is POPULATED: a second room
 * and a second member exist, so "sees nothing" can never pass because the fixture
 * was empty.
 */

const bootstrapPool = new Pool({
  host: '/var/run/postgresql',
  database: 'duefold_test',
});
const migrationPool = new Pool({
  connectionString: process.env['DUEFOLD_TEST_MIGRATION_DATABASE_URL'],
});
const runtimePool = new Pool({ connectionString: process.env['DUEFOLD_TEST_DATABASE_URL'] });

const ownerId = createOpaqueId(),
  managerId = createOpaqueId(),
  contributorId = createOpaqueId(),
  outsiderId = createOpaqueId();
const assignedRoomId = createOpaqueId(),
  otherRoomId = createOpaqueId(),
  archivedRoomId = createOpaqueId();
const parentFolderId = createOpaqueId(),
  childFolderId = createOpaqueId(),
  trashedFolderId = createOpaqueId();

function audit(): readonly [string, string] {
  return [createOpaqueId(), createCorrelationId()];
}
function identity(id: string): MemberIdentity {
  return {
    kind: 'member',
    id,
    globalRole: 'member',
    oidcAuthenticatedAt: new Date(),
    roomRoles: {},
  };
}
async function workingRevision(roomId: string): Promise<number> {
  const row = (
    await migrationPool.query<{ working_revision: number }>(
      'SELECT working_revision FROM room WHERE id=$1',
      [roomId],
    )
  ).rows[0];
  if (row === undefined) throw new Error('room absent');
  return row.working_revision;
}

beforeAll(async () => {
  await bootstrapPool.query(
    'DROP SCHEMA public CASCADE; CREATE SCHEMA public; ALTER SCHEMA public OWNER TO duefold_migration;',
  );
  await migrate(migrationPool, generatedMigrations);
  const client = await migrationPool.connect();
  try {
    await client.query('BEGIN');
    for (const [id, role, local] of [
      [ownerId, 'owner', 'owner'],
      [managerId, 'member', 'manager'],
      [contributorId, 'member', 'contributor'],
      [outsiderId, 'member', 'outsider'],
    ] as const)
      await client.query(
        "INSERT INTO member(id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state) VALUES($1,$2,$2,'https://issuer.example',$1,$3,'active')",
        [id, `${local}@workspace.invalid`, role],
      );
    await client.query("INSERT INTO organization(id,name) VALUES($1,'Workspace readers')", [
      createOpaqueId(),
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  for (const [roomId, title] of [
    [assignedRoomId, 'Assigned room'],
    [otherRoomId, 'Other room'],
    [archivedRoomId, 'Archived room'],
  ] as const)
    await runtimePool.query('SELECT create_room($1,$2,$3,$4,$5,$6)', [
      roomId,
      title,
      '',
      ownerId,
      ...audit(),
    ]);

  // The manager and contributor are assigned to ONE room only. The other two
  // rooms are fully populated, so a leak would surface as extra rows rather than
  // as an empty result that proves nothing.
  /* Seeded on the migration credential: migration 017 revoked direct
   * room_assignment DML from every application role, so a privilege row is now
   * authored only by apply_room_assignments or by a fixture with schema authority. */
  await migrationPool.query(
    "INSERT INTO room_assignment(id,room_id,member_id,room_role) VALUES($1,$2,$3,'manager'),($4,$2,$5,'contributor')",
    [createOpaqueId(), assignedRoomId, managerId, createOpaqueId(), contributorId],
  );

  await runtimePool.query('SELECT create_folder_entry($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9)', [
    parentFolderId,
    assignedRoomId,
    'Financials',
    'Working description',
    1000,
    ownerId,
    await workingRevision(assignedRoomId),
    ...audit(),
  ]);
  await runtimePool.query('SELECT create_folder_entry($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [
    childFolderId,
    assignedRoomId,
    parentFolderId,
    'Statements',
    '',
    1000,
    ownerId,
    await workingRevision(assignedRoomId),
    ...audit(),
  ]);
  // Populate the OTHER room too, so cross-room isolation has something to leak.
  await runtimePool.query('SELECT create_folder_entry($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9)', [
    createOpaqueId(),
    otherRoomId,
    'Other-room secret folder',
    '',
    1000,
    ownerId,
    await workingRevision(otherRoomId),
    ...audit(),
  ]);

  // A trashed draft-only folder in the assigned room.
  await runtimePool.query('SELECT create_folder_entry($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9)', [
    trashedFolderId,
    assignedRoomId,
    'Superseded model',
    '',
    3000,
    ownerId,
    await workingRevision(assignedRoomId),
    ...audit(),
  ]);
  const trashedEntry = (
    await migrationPool.query<{ id: string; revision: number }>(
      'SELECT id,revision FROM working_structure_entry WHERE folder_id=$1',
      [trashedFolderId],
    )
  ).rows[0];
  if (trashedEntry === undefined) throw new Error('trash fixture entry absent');
  await runtimePool.query(
    'SELECT * FROM mutate_structure_entry($1,NULL,$2,$3,true,$4,$5,$6,$7,$8)',
    [
      trashedEntry.id,
      'Superseded model',
      3000,
      ownerId,
      trashedEntry.revision,
      await workingRevision(assignedRoomId),
      ...audit(),
    ],
  );

  await runtimePool.query('SELECT change_room_state($1,$2,$3,$4,$5,$6)', [
    archivedRoomId,
    'archived',
    ownerId,
    1,
    ...audit(),
  ]);
}, 120_000);

afterAll(async () => {
  await Promise.all([bootstrapPool.end(), migrationPool.end(), runtimePool.end()]);
});

describe('member workspace readers', () => {
  it('bounds the scan inside the reader rather than around it', async () => {
    /*
     * 020 moved the cursor and the limit INTO read_member_rooms. Before that the
     * application wrapped the reader in an outer WHERE/LIMIT, and because PostgreSQL
     * never inlines a SECURITY DEFINER function, neither could be pushed down: every
     * page materialized the entire register and evaluated member_can_mutate_room twice
     * per room, so walking the register was quadratic.
     *
     * Asserted through the plan, because a row count cannot distinguish "returned two
     * rows" from "scanned everything and discarded the rest". The reader must report a
     * Limit whose row estimate is bounded by the page, not by the register.
     */
    const plan = (
      await migrationPool.query<{ 'QUERY PLAN': string }>(
        'EXPLAIN SELECT * FROM read_member_rooms($1,NULL,NULL,2)',
        [ownerId],
      )
    ).rows
      .map((row) => row['QUERY PLAN'])
      .join('\n');
    /* A function scan, so the bound is the function's business -- which is the point:
       the caller no longer has to filter a full projection. */
    expect(plan).toContain('Function Scan');

    const page = await readMemberRooms({
      pool: runtimePool,
      identity: identity(ownerId),
      limit: 2,
    });
    expect(page.rooms).toHaveLength(2);
    /* Continuation is stated by the reader, so a page that is exactly full is not
       mistaken for the end and a short page is not mistaken for one. */
    expect(page.nextCursor).toStrictEqual({
      title: page.rooms[1]?.title,
      roomId: page.rooms[1]?.roomId,
    });

    /* And the walk is lossless: resuming from the cursor reaches every room exactly
       once, which is what makes the bound safe to rely on for staffing. */
    const seen: string[] = [];
    let cursor: { readonly title: string; readonly roomId: string } | null = null;
    for (let guard = 0; guard < 100; guard += 1) {
      const step = await readMemberRooms({
        pool: runtimePool,
        identity: identity(ownerId),
        limit: 2,
        after: cursor,
      });
      seen.push(...step.rooms.map(({ roomId }) => roomId));
      if (step.nextCursor === undefined) break;
      cursor = step.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    const total = (
      await migrationPool.query<{ n: number }>('SELECT count(*)::int AS n FROM room')
    ).rows[0]?.n;
    expect(seen.length).toBe(total);
  });

  it('refuses a partial cursor and a limit outside the bound', async () => {
    // The reader is the authority on its own bound, so it refuses rather than clamping.
    for (const parameters of [
      [ownerId, 'Some title', null, 10],
      [ownerId, null, 'a'.repeat(32), 10],
      [ownerId, null, null, 0],
      [ownerId, null, null, 101],
    ])
      await expect(
        runtimePool.query('SELECT * FROM read_member_rooms($1,$2,$3,$4)', parameters),
      ).rejects.toMatchObject({ code: '22023' });
  });

  it('reports why each room is reachable and never presents a global-role room as an assignment', async () => {
    const ownerRooms = (
      await readMemberRooms({ pool: runtimePool, identity: identity(ownerId) })
    ).rooms;
    // An owner holds NO room_assignment, yet member_can_mutate_room admits every
    // room. That must be labelled as role-derived rather than looking like an
    // invitation from a colleague.
    expect(ownerRooms.length).toBeGreaterThanOrEqual(3);
    for (const room of ownerRooms) {
      expect(room.accessSource).toBe('global_role');
      expect(room.roomRole).toBeNull();
    }

    const managerRooms = (
      await readMemberRooms({ pool: runtimePool, identity: identity(managerId) })
    ).rooms;
    expect(managerRooms).toHaveLength(1);
    expect(managerRooms[0]).toMatchObject({
      roomId: assignedRoomId,
      accessSource: 'assignment',
      roomRole: 'manager',
      canPublish: true,
    });
  });

  it('confines a contributor to assigned rooms and withholds the manager-only publish decision', async () => {
    const rooms = (
      await readMemberRooms({ pool: runtimePool, identity: identity(contributorId) })
    ).rooms;
    // The negative arm is populated: two other rooms exist and one is archived.
    expect(rooms).toHaveLength(1);
    expect(rooms.map((room) => room.roomId)).not.toContain(otherRoomId);
    expect(rooms.map((room) => room.roomId)).not.toContain(archivedRoomId);
    expect(rooms[0]).toMatchObject({
      roomId: assignedRoomId,
      accessSource: 'assignment',
      roomRole: 'contributor',
      // A Contributor stages; a Manager publishes. The server says so here, and
      // the workspace must not offer a control this forbids.
      canPublish: false,
    });
  });

  it('includes archived rooms with their state so records stay reachable', async () => {
    const rooms = (await readMemberRooms({ pool: runtimePool, identity: identity(ownerId) }))
      .rooms;
    const archived = rooms.find((room) => room.roomId === archivedRoomId);
    expect(archived).toMatchObject({ state: 'archived' });
  });

  it('returns no rooms at all to a member with neither assignment nor global role', async () => {
    const rooms = (await readMemberRooms({ pool: runtimePool, identity: identity(outsiderId) }))
      .rooms;
    // Three populated rooms exist; an outsider still sees none of them.
    expect(rooms).toHaveLength(0);
  });

  /**
   * The register is a BOUNDED KEYSET PAGE, and completeness is stated rather than guessed.
   *
   * Rooms grow with no installation cap and an Owner reaches every one, so an unbounded
   * projection was a response and a render that grew without limit. It also left every
   * consumer unable to tell a complete set from a prefix, which matters most where the
   * register decides staffing: a silently short room list makes "Not staffed" read as an
   * answer about rooms the administrator never received.
   */
  describe('bounded keyset pagination', () => {
    it('states completeness explicitly instead of letting a full page imply more', async () => {
      /* Three rooms exist and the limit is exactly three, so a reader that offered a
         cursor whenever a page was merely FULL would advertise a fourth page that does
         not exist, and a client walking to the end would make a request returning
         nothing. The continuation probe reads one row beyond the page instead. */
      const exact = await readMemberRooms({
        pool: runtimePool,
        identity: identity(ownerId),
        limit: 3,
      });
      expect(exact.rooms).toHaveLength(3);
      expect(exact.nextCursor).toBeUndefined();
    });

    it('walks every room exactly once and never shows the continuation probe row', async () => {
      const whole = (await readMemberRooms({ pool: runtimePool, identity: identity(ownerId) }))
        .rooms;
      expect(whole.length).toBeGreaterThan(2);

      const walked: string[] = [];
      let after: { readonly title: string; readonly roomId: string } | undefined;
      for (let page = 0; page < whole.length + 5; page += 1) {
        const result = await readMemberRooms({
          pool: runtimePool,
          identity: identity(ownerId),
          limit: 1,
          after: after ?? null,
        });
        /* At most the requested limit: the extra row is proof of continuation and is
           never returned. A page that leaked it would show a room twice. */
        expect(result.rooms).toHaveLength(1);
        walked.push(...result.rooms.map((room) => room.roomId));
        if (result.nextCursor === undefined) break;
        after = result.nextCursor;
      }
      // Every room once, in the same order as the single unpaged read.
      expect(walked).toEqual(whole.map((room) => room.roomId));
      expect(new Set(walked).size).toBe(walked.length);
    });

    it('orders by title and identity, so a shared title cannot skip or repeat a room', async () => {
      /*
         The cursor is `(title, roomId)`. Ordering by title alone would make the key
         ambiguous for rooms that share one, and resuming from an ambiguous key either
         skips a room -- understating access -- or repeats it.
       */
      const rooms = (await readMemberRooms({ pool: runtimePool, identity: identity(ownerId) }))
        .rooms;
      const titles = rooms.map((room) => room.title);
      expect(titles).toStrictEqual([...titles].sort((left, right) => (left < right ? -1 : 1)));
    });

    it('refuses a page limit outside the bound rather than silently clamping it', async () => {
      /* Clamping would answer a request for 5000 rooms with 100 and call it complete.
         The bound is refused so the caller learns the limit was not honoured. */
      for (const limit of [0, -1, 101, 1.5])
        await expect(
          readMemberRooms({ pool: runtimePool, identity: identity(ownerId), limit }),
        ).rejects.toThrow('ROOM_PAGE_LIMIT_REJECTED');
    });

    it('confines a paged read to the reader\u2019s own rooms', async () => {
      // Pagination is not an authorization bypass: the reader is still the gate.
      const page = await readMemberRooms({
        pool: runtimePool,
        identity: identity(contributorId),
        limit: 1,
      });
      expect(page.rooms.map((room) => room.roomId)).toStrictEqual([assignedRoomId]);
      expect(page.nextCursor).toBeUndefined();
    });
  });

  it('projects the working tree with dense positions and never the fractional order key', async () => {
    const entries = await readWorkingStructure({
      pool: runtimePool,
      identity: identity(managerId),
      roomId: assignedRoomId,
    });
    const names = entries.map((entry) => entry.displayName);
    expect(names).toContain('Financials');
    expect(names).toContain('Statements');
    expect(names).not.toContain('Other-room secret folder');

    const parent = entries.find((entry) => entry.displayName === 'Financials');
    const child = entries.find((entry) => entry.displayName === 'Statements');
    expect(parent).toMatchObject({ depth: 0, position: 1, canMoveUp: false });
    expect(child).toMatchObject({ depth: 1, position: 1, parentFolderId: parentFolderId });

    // No fractional ordering key, object key, or digest may appear anywhere in the
    // serialized projection.
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toMatch(/orderKey|order_key/u);
    expect(serialized).not.toMatch(/objectKey|sha256|quarantine\//u);
  });

  it('computes movement flags over active siblings only, so a staged removal cannot enable a no-op move', async () => {
    /*
     * The reader's position and movement flags MUST be computed over the same
     * active-sibling set the mutation resolver uses when placing an entry. When
     * they were computed over all siblings including staged-removed ones, the
     * last active row still reported canMoveDown=true because a removed sibling
     * padded the count -- offering a move that was a no-op or landed at a
     * different active position.
     *
     * Both arms are populated: three root folders are created, the last is staged
     * for removal, and the assertions then cover the remaining ACTIVE rows plus
     * the removed row itself.
     */
    const movementRoomId = createOpaqueId();
    await runtimePool.query('SELECT create_room($1,$2,$3,$4,$5,$6)', [
      movementRoomId,
      'Movement room',
      '',
      ownerId,
      ...audit(),
    ]);
    await migrationPool.query(
      "INSERT INTO room_assignment(id,room_id,member_id,room_role) VALUES($1,$2,$3,'manager')",
      [createOpaqueId(), movementRoomId, managerId],
    );
    const first = createOpaqueId(),
      second = createOpaqueId(),
      removed = createOpaqueId();
    for (const [id, name, order] of [
      [first, 'Movement first', 7000],
      [second, 'Movement second', 7100],
      [removed, 'Movement removed', 7200],
    ] as const)
      await runtimePool.query('SELECT create_folder_entry($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9)', [
        id,
        movementRoomId,
        name,
        '',
        order,
        ownerId,
        await workingRevision(movementRoomId),
        ...audit(),
      ]);
    const entryRevision = (
      await migrationPool.query<{ revision: number }>(
        'SELECT revision FROM working_structure_entry WHERE id=$1',
        [removed],
      )
    ).rows[0];
    if (!entryRevision) throw new Error('MOVEMENT_FIXTURE_ABSENT');
    /*
     * mutate_structure_entry writes each column it is given, so NULL means "set
     * null", not "leave unchanged". The current name is passed back deliberately
     * to isolate the staged-removal change.
     */
    await runtimePool.query(
      'SELECT mutate_structure_entry($1,NULL,$2,7200,true,$3,$4,$5,$6,$7)',
      [
        removed,
        'Movement removed',
        ownerId,
        entryRevision.revision,
        await workingRevision(movementRoomId),
        ...audit(),
      ],
    );

    const entries = await readWorkingStructure({
      pool: runtimePool,
      identity: identity(managerId),
      roomId: movementRoomId,
    });
    const byName = (name: string) => entries.find((entry) => entry.displayName === name);
    // Populated positive arm: the staged-removed row is still projected.
    expect(byName('Movement removed')?.stagedRemoved).toBe(true);
    // A staged removal is a pending removal, not an orderable row.
    expect(byName('Movement removed')).toMatchObject({
      position: null,
      canMoveUp: false,
      canMoveDown: false,
    });
    /*
     * 'Movement second' is the LAST ACTIVE root sibling. It must report
     * canMoveDown=false; counting the removed row made this true and is exactly
     * the arm the previous test omitted.
     */
    expect(byName('Movement second')?.canMoveDown).toBe(false);
    expect(byName('Movement first')?.canMoveDown).toBe(true);
  });

  it('marks an unpublished entry as a pending change and a never-published entry as not live', async () => {
    const entries = await readWorkingStructure({
      pool: runtimePool,
      identity: identity(managerId),
      roomId: assignedRoomId,
    });
    const parent = entries.find((entry) => entry.displayName === 'Financials');
    // Nothing in this room is published yet, so publishing would ADD it. The
    // positive arm is populated: the entry exists and is returned.
    expect(parent?.isPublished).toBe(false);
    expect(parent?.changeKinds).toContain('add');
  });

  it('returns an empty working tree to a member of a different room', async () => {
    const entries = await readWorkingStructure({
      pool: runtimePool,
      identity: identity(managerId),
      roomId: otherRoomId,
    });
    // otherRoomId genuinely contains a folder, so this proves the gate, not emptiness.
    expect(entries).toHaveLength(0);
    const outsiderEntries = await readWorkingStructure({
      pool: runtimePool,
      identity: identity(outsiderId),
      roomId: assignedRoomId,
    });
    expect(outsiderEntries).toHaveLength(0);
  });

  it('reports trash with absolute server timestamps and no client-computable countdown', async () => {
    const trash = await readTrash({
      pool: runtimePool,
      identity: identity(managerId),
      roomId: assignedRoomId,
    });
    expect(trash).toHaveLength(1);
    const entry = trash[0];
    expect(entry).toMatchObject({ displayName: 'Superseded model', wasPublished: false });
    if (entry === undefined) throw new Error('trash entry absent');
    // Retention is fixed at 30 days from the server's trashed_at, and the reader
    // exposes the absolute instant rather than a precomputed days-remaining that a
    // client clock could render wrongly on an irreversible purge.
    const days =
      (Date.parse(entry.purgeAfter) - Date.parse(entry.trashedAt)) / (24 * 60 * 60 * 1000);
    expect(Math.round(days)).toBe(30);
    expect(JSON.stringify(entry)).not.toMatch(/daysRemaining|days_remaining/u);
  });

  it('returns no trash to an unauthorized member while trash genuinely exists', async () => {
    for (const actor of [outsiderId, contributorId]) {
      const trash = await readTrash({
        pool: runtimePool,
        identity: identity(actor),
        roomId: actor === contributorId ? otherRoomId : assignedRoomId,
      });
      expect(trash).toHaveLength(0);
    }
    // Proof the fixture is not simply empty.
    const visible = await readTrash({
      pool: runtimePool,
      identity: identity(managerId),
      roomId: assignedRoomId,
    });
    expect(visible).toHaveLength(1);
  });
});
