import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import {
  activeAssignments,
  closeAdministrationPools,
  databasePool,
  migrationPool,
  seedAdministrationFixture,
  type AdministrationFixture,
} from './support/administration-fixture.ts';

let fixture: AdministrationFixture;
let ownerId: string;
let plainMemberId: string;
let targetMemberId: string;
let disposableMemberId: string;
let secondSuccessorId: string;
let firstRoomId: string;
let bulkRoomIds: readonly string[];

beforeAll(async () => {
  fixture = await seedAdministrationFixture({ bulkRooms: true });
  ({
    ownerId,
    plainMemberId,
    targetMemberId,
    disposableMemberId,
    secondSuccessorId,
    firstRoomId,
    bulkRoomIds,
  } = fixture);
  await databasePool.query('SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)', [
    createOpaqueId(),
    'listed.invitation@example.test',
    'Listed.Invitation@example.test',
    'member',
    ownerId,
    createOpaqueId(),
    createOpaqueId(),
    createCorrelationId(),
  ]);
});

afterAll(closeAdministrationPools);

describe('read_members', () => {
  it('returns members and pending invitations, and refuses a plain member', async () => {
    const rows = await databasePool.query<{ subject_kind: string }>(
      'SELECT subject_kind FROM read_members($1,$2,$3,$4)',
      [ownerId, null, null, 100],
    );
    expect(rows.rows.some(({ subject_kind }) => subject_kind === 'member')).toBe(true);
    expect(rows.rows.some(({ subject_kind }) => subject_kind === 'invitation')).toBe(true);
    await expect(
      databasePool.query('SELECT * FROM read_members($1,$2,$3,$4)', [
        plainMemberId,
        null,
        null,
        100,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('rejects an absent, zero, negative, or oversized page size', async () => {
    for (const limit of [null, 0, -1, 101, 102, 10_000])
      await expect(
        databasePool.query('SELECT * FROM read_members($1,$2,$3,$4)', [
          ownerId,
          null,
          null,
          limit,
        ]),
      ).rejects.toMatchObject({ code: '22023' });
    await expect(
      databasePool.query('SELECT * FROM read_members($1,$2,$3,$4)', [ownerId, null, null, 100]),
    ).resolves.toBeDefined();
  });

  it('rejects an incomplete cursor', async () => {
    for (const [after, subject] of [
      [new Date(), null],
      [null, createOpaqueId()],
    ] as const)
      await expect(
        databasePool.query('SELECT * FROM read_members($1,$2,$3,$4)', [
          ownerId,
          after,
          subject,
          10,
        ]),
      ).rejects.toMatchObject({ code: '22023' });
  });

  it('walks every subject exactly once through the keyset cursor', async () => {
    const all = (
      await databasePool.query<{
        subject_id: string;
        created_at: Date;
        cursor_created_at: string;
      }>('SELECT subject_id,created_at,cursor_created_at FROM read_members($1,$2,$3,$4)', [
        ownerId,
        null,
        null,
        100,
      ])
    ).rows;
    expect(all.length).toBeGreaterThan(3);
    expect(new Set(all.map(({ created_at }) => created_at.getTime())).size).toBeLessThan(
      all.length,
    );

    const walked: string[] = [];
    let cursor: { createdAt: string; subjectId: string } | undefined;
    for (let page = 0; page < all.length + 5; page += 1) {
      const rows = (
        await databasePool.query<{ subject_id: string; cursor_created_at: string }>(
          'SELECT subject_id,cursor_created_at FROM read_members($1,$2,$3,$4)',
          [ownerId, cursor?.createdAt ?? null, cursor?.subjectId ?? null, 1],
        )
      ).rows;
      if (rows.length === 0) break;
      const row = rows[0];
      if (row === undefined) break;
      walked.push(row.subject_id);
      cursor = { createdAt: row.cursor_created_at, subjectId: row.subject_id };
    }
    expect(walked).toEqual(all.map(({ subject_id }) => subject_id));
    expect(new Set(walked).size).toBe(walked.length);
  });

  it('pages losslessly on the exact server timestamp a truncated one would skip', async () => {
    const all = (
      await databasePool.query<{ subject_id: string; cursor_created_at: string }>(
        'SELECT subject_id,cursor_created_at FROM read_members($1,$2,$3,$4)',
        [ownerId, null, null, 100],
      )
    ).rows;
    const index = all.findIndex(
      (row, position) => all[position + 1]?.cursor_created_at === row.cursor_created_at,
    );
    const pivot = all[index];
    if (pivot === undefined) throw new Error('no subjects share an instant');
    const ties = all.filter(
      ({ cursor_created_at }) => cursor_created_at === pivot.cursor_created_at,
    ).length;
    expect(ties).toBeGreaterThan(1);

    const remaining = (
      await databasePool.query<{ subject_id: string }>(
        'SELECT subject_id FROM read_members($1,$2,$3,$4)',
        [ownerId, pivot.cursor_created_at, pivot.subject_id, 100],
      )
    ).rows;
    expect(remaining.map(({ subject_id }) => subject_id)).toEqual(
      all.slice(index + 1).map(({ subject_id }) => subject_id),
    );

    const truncated = new Date(pivot.cursor_created_at).toISOString();
    expect(truncated).not.toBe(pivot.cursor_created_at);
    const lossy = (
      await databasePool.query<{ subject_id: string }>(
        'SELECT subject_id FROM read_members($1,$2,$3,$4)',
        [ownerId, truncated, pivot.subject_id, 100],
      )
    ).rows;
    expect(lossy.length).toBeLessThan(remaining.length);
    for (const skipped of all
      .slice(index + 1)
      .filter(({ cursor_created_at }) => cursor_created_at === pivot.cursor_created_at))
      expect(lossy.map(({ subject_id }) => subject_id)).not.toContain(skipped.subject_id);
  });
});

describe('read_members assignment completeness', () => {
  const staffed = (): readonly string[] => [
    targetMemberId,
    disposableMemberId,
    secondSuccessorId,
  ];

  beforeEach(async () => {
    await migrationPool.query(
      "UPDATE member SET global_role='member',state='active' WHERE id = ANY($1)",
      [[...staffed()]],
    );
    await migrationPool.query('DELETE FROM room_assignment WHERE member_id = ANY($1)', [
      [...staffed()],
    ]);
  });

  async function subjectTotal(): Promise<number> {
    const total = (
      await migrationPool.query<{ count: number }>(
        `SELECT ((SELECT count(*) FROM member)
               + (SELECT count(*) FROM invitation
                   WHERE kind='member' AND state='pending'
                     AND expires_at>statement_timestamp()))::int AS count`,
      )
    ).rows[0]?.count;
    if (total === undefined) throw new Error('subject total unavailable');
    return total;
  }

  interface PageRow {
    readonly subject_id: string;
    readonly subject_kind: string;
    readonly cursor_created_at: string;
    readonly continues: boolean;
    readonly assignments: readonly { readonly roomId: string; readonly roomRole: string }[];
  }

  async function page(
    limit: number,
    after?: { readonly createdAt: string; readonly subjectId: string },
  ): Promise<readonly PageRow[]> {
    return (
      await databasePool.query<PageRow>('SELECT * FROM read_members($1,$2,$3,$4)', [
        ownerId,
        after?.createdAt ?? null,
        after?.subjectId ?? null,
        limit,
      ])
    ).rows;
  }

  async function staffAcrossBulkRooms(memberId: string): Promise<void> {
    for (let offset = 0; offset < bulkRoomIds.length; offset += 100)
      await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
        memberId,
        JSON.stringify(
          bulkRoomIds
            .slice(offset, offset + 100)
            .map((roomId) => ({ roomId, roomRole: 'contributor' })),
        ),
        JSON.stringify([]),
        ownerId,
        createOpaqueId(),
        createCorrelationId(),
      ]);
    expect(await activeAssignments(memberId)).toHaveLength(bulkRoomIds.length);
  }

  it('projects active assignments for an administrator and refuses a plain member', async () => {
    await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
      targetMemberId,
      JSON.stringify([{ roomId: firstRoomId, roomRole: 'manager' }]),
      JSON.stringify([]),
      ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    const held = (await page(100)).find(({ subject_id }) => subject_id === targetMemberId);
    expect(held?.assignments).toEqual([{ roomId: firstRoomId, roomRole: 'manager' }]);
    await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
      targetMemberId,
      JSON.stringify([]),
      JSON.stringify([firstRoomId]),
      ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    expect(
      (await page(100)).find(({ subject_id }) => subject_id === targetMemberId)?.assignments,
    ).toEqual([]);
    await expect(
      databasePool.query('SELECT * FROM read_members($1,$2,$3,$4)', [
        plainMemberId,
        null,
        null,
        100,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('gives a pending invitation an empty assignment array rather than null', async () => {
    const invitation = (await page(100)).find(
      ({ subject_kind }) => subject_kind === 'invitation',
    );
    expect(invitation).toBeDefined();
    expect(invitation?.assignments).toEqual([]);
  });

  it('bounds a page by dropping trailing subjects, never by shortening one member', async () => {
    for (const memberId of staffed()) await staffAcrossBulkRooms(memberId);
    const total = await subjectTotal();
    expect(total).toBeGreaterThan(staffed().length);
    expect(total).toBeLessThan(100);

    const walked: string[] = [];
    let cursor: { readonly createdAt: string; readonly subjectId: string } | undefined;
    let pages = 0;
    for (;;) {
      const rows = await page(100, cursor);
      pages += 1;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.reduce((sum, row) => sum + row.assignments.length, 0)).toBeLessThanOrEqual(
        500,
      );
      for (const row of rows) {
        walked.push(row.subject_id);
        if (staffed().includes(row.subject_id))
          expect(row.assignments, row.subject_id).toHaveLength(bulkRoomIds.length);
      }
      const last = rows.at(-1);
      if (last?.continues !== true) break;
      expect(rows.length).toBeLessThan(100);
      cursor = { createdAt: last.cursor_created_at, subjectId: last.subject_id };
      expect(pages).toBeLessThan(20);
    }
    expect(pages).toBeGreaterThan(1);
    expect(walked).toHaveLength(total);
    expect(new Set(walked).size).toBe(walked.length);
  });

  it('always admits the leading subject so a one-subject walk cannot stall', async () => {
    for (const memberId of staffed()) await staffAcrossBulkRooms(memberId);
    const total = await subjectTotal();
    const walked: string[] = [];
    let cursor: { readonly createdAt: string; readonly subjectId: string } | undefined;
    for (let step = 0; step < total + 5; step += 1) {
      const rows = await page(1, cursor);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (row === undefined) throw new Error('page unexpectedly empty');
      walked.push(row.subject_id);
      if (staffed().includes(row.subject_id))
        expect(row.assignments, row.subject_id).toHaveLength(bulkRoomIds.length);
      if (!row.continues) break;
      cursor = { createdAt: row.cursor_created_at, subjectId: row.subject_id };
    }
    expect(walked).toHaveLength(total);
    expect(new Set(walked).size).toBe(walked.length);
  });
});
