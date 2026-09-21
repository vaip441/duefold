import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import {
  activeAssignments,
  activeSessionFor,
  backendPid,
  closeAdministrationPools,
  currentRevision,
  databasePool,
  migrationPool,
  revokedSessionCount,
  seedAdministrationFixture,
  sessionState,
  waitUntilBlocked,
  type AdministrationFixture,
} from './support/administration-fixture.ts';

let fixture: AdministrationFixture;
let ownerId: string;
let adminId: string;
let disabledAdminId: string;
let plainMemberId: string;
let targetMemberId: string;
let disabledMemberId: string;
let firstRoomId: string;
let secondRoomId: string;

beforeAll(async () => {
  fixture = await seedAdministrationFixture();
  ({
    ownerId,
    adminId,
    disabledAdminId,
    plainMemberId,
    targetMemberId,
    disabledMemberId,
    firstRoomId,
    secondRoomId,
  } = fixture);
});

afterAll(closeAdministrationPools);

describe('apply_room_assignments', () => {
  beforeEach(async () => {
    await migrationPool.query('DELETE FROM room_assignment WHERE member_id=$1', [
      targetMemberId,
    ]);
    await migrationPool.query(
      "UPDATE member SET global_role='member',state='active' WHERE id=$1",
      [targetMemberId],
    );
  });

  it('refuses an Owner or Admin target, and an inactive or unknown member alike', async () => {
    for (const target of [ownerId, adminId, disabledMemberId, createOpaqueId()])
      await expect(
        databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
          target,
          JSON.stringify([{ roomId: firstRoomId, roomRole: 'contributor' }]),
          JSON.stringify([]),
          ownerId,
          createOpaqueId(),
          createCorrelationId(),
        ]),
      ).rejects.toMatchObject({ code: '42501' });
    expect(
      (
        await migrationPool.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM room_assignment WHERE member_id = ANY($1)',
          [[ownerId, adminId, disabledMemberId]],
        )
      ).rows[0]?.count,
    ).toBe(0);
  });

  it('refuses an administrator assigning or revoking their own rooms', async () => {
    const actorSession = await activeSessionFor(adminId);
    for (const [assign, revoke] of [
      [[{ roomId: firstRoomId, roomRole: 'manager' }], []],
      [[], [firstRoomId]],
    ] as const)
      await expect(
        databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
          adminId,
          JSON.stringify(assign),
          JSON.stringify(revoke),
          adminId,
          createOpaqueId(),
          createCorrelationId(),
        ]),
      ).rejects.toMatchObject({ code: '42501' });
    expect(await sessionState(actorSession)).toBe('active');
  });

  it('refuses an unknown room in the revocation list rather than reporting success', async () => {
    const unknownRoomId = createOpaqueId();
    const auditsBefore = (
      await migrationPool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM audit_event WHERE event_type='room.assignment'",
      )
    ).rows[0]?.count;
    await expect(
      databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
        targetMemberId,
        JSON.stringify([]),
        JSON.stringify([unknownRoomId]),
        ownerId,
        createOpaqueId(),
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
        targetMemberId,
        JSON.stringify([{ roomId: firstRoomId, roomRole: 'manager' }]),
        JSON.stringify([unknownRoomId]),
        ownerId,
        createOpaqueId(),
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    expect(await activeAssignments(targetMemberId)).toEqual([]);
    expect(
      (
        await migrationPool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM audit_event WHERE event_type='room.assignment'",
        )
      ).rows[0]?.count,
    ).toBe(auditsBefore);
  });

  it('refuses revoking a valid room the member does not hold, as a no-op', async () => {
    await expect(
      databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
        targetMemberId,
        JSON.stringify([]),
        JSON.stringify([secondRoomId]),
        ownerId,
        createOpaqueId(),
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '22023' });
  });

  it('writes no audit row for a batch it refused as a no-op', async () => {
    const auditId = createOpaqueId();
    await expect(
      databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
        targetMemberId,
        JSON.stringify([]),
        JSON.stringify([secondRoomId]),
        ownerId,
        auditId,
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '22023' });
    expect(
      (
        await migrationPool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM audit_event WHERE id=$1',
          [auditId],
        )
      ).rows[0]?.n,
    ).toBe(0);
  });

  it('assigns several rooms in one transaction, revokes sessions once, and returns the resulting set', async () => {
    const sessionId = await activeSessionFor(targetMemberId);
    const auditId = createOpaqueId();
    const applied = (
      await databasePool.query<{
        apply_room_assignments: {
          readonly memberId: string;
          readonly changed: number;
          readonly assignments: readonly {
            readonly roomId: string;
            readonly roomRole: string;
          }[];
        };
      }>('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
        targetMemberId,
        JSON.stringify([
          { roomId: firstRoomId, roomRole: 'manager' },
          { roomId: secondRoomId, roomRole: 'contributor' },
        ]),
        JSON.stringify([]),
        ownerId,
        auditId,
        createCorrelationId(),
      ])
    ).rows[0]?.apply_room_assignments;
    expect(applied?.changed).toBe(2);
    const stored = await activeAssignments(targetMemberId);
    expect(applied?.assignments).toEqual(
      stored.map(({ room_id, room_role }) => ({ roomId: room_id, roomRole: room_role })),
    );
    expect(
      applied?.assignments.toSorted((left, right) => left.roomId.localeCompare(right.roomId)),
    ).toEqual(
      [
        { roomId: firstRoomId, roomRole: 'manager' },
        { roomId: secondRoomId, roomRole: 'contributor' },
      ].toSorted((left, right) => left.roomId.localeCompare(right.roomId)),
    );
    expect(stored).toHaveLength(2);
    expect(await sessionState(sessionId)).toBe('revoked');
    expect(
      (
        await migrationPool.query<{
          event_type: string;
          reason_code: string;
          subject_id: string;
          detail: Readonly<Record<string, unknown>>;
        }>('SELECT event_type,reason_code,subject_id,detail FROM audit_event WHERE id=$1', [
          auditId,
        ])
      ).rows[0],
    ).toEqual({
      event_type: 'room.assignment',
      reason_code: 'ROOM_ASSIGNMENTS_APPLIED',
      subject_id: targetMemberId,
      detail: {
        assigned: [
          { roomId: firstRoomId, roomRole: 'manager' },
          { roomId: secondRoomId, roomRole: 'contributor' },
        ],
        revoked: [],
        changed: 2,
      },
    });
  });

  it('produces exactly one session revocation for a two-room batch', async () => {
    const before = await revokedSessionCount(targetMemberId);
    const sessionId = await activeSessionFor(targetMemberId);
    await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
      targetMemberId,
      JSON.stringify([
        { roomId: firstRoomId, roomRole: 'manager' },
        { roomId: secondRoomId, roomRole: 'contributor' },
      ]),
      JSON.stringify([]),
      ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    expect(await sessionState(sessionId)).toBe('revoked');
    expect(await revokedSessionCount(targetMemberId)).toBe(before + 1);
  });

  it('applies assignments and revocations together in one call', async () => {
    await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
      targetMemberId,
      JSON.stringify([{ roomId: firstRoomId, roomRole: 'manager' }]),
      JSON.stringify([]),
      ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    const applied = (
      await databasePool.query<{
        apply_room_assignments: {
          readonly changed: number;
          readonly assignments: readonly { readonly roomId: string }[];
        };
      }>('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
        targetMemberId,
        JSON.stringify([{ roomId: secondRoomId, roomRole: 'contributor' }]),
        JSON.stringify([firstRoomId]),
        ownerId,
        createOpaqueId(),
        createCorrelationId(),
      ])
    ).rows[0]?.apply_room_assignments;
    expect(applied?.changed).toBe(2);
    expect(applied?.assignments).toEqual([{ roomId: secondRoomId, roomRole: 'contributor' }]);
  });

  it('re-staffs a revoked room by adding a new assignment and retaining the revoked one', async () => {
    await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
      targetMemberId,
      JSON.stringify([{ roomId: firstRoomId, roomRole: 'manager' }]),
      JSON.stringify([]),
      ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    const original = (
      await migrationPool.query<{ id: string }>(
        'SELECT id FROM room_assignment WHERE member_id=$1 AND room_id=$2',
        [targetMemberId, firstRoomId],
      )
    ).rows[0]?.id;
    await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
      targetMemberId,
      JSON.stringify([]),
      JSON.stringify([firstRoomId]),
      ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
      targetMemberId,
      JSON.stringify([{ roomId: firstRoomId, roomRole: 'contributor' }]),
      JSON.stringify([]),
      ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    const rows = (
      await migrationPool.query<{ id: string; room_role: string; state: string }>(
        `SELECT id,room_role,state FROM room_assignment
          WHERE member_id=$1 AND room_id=$2 ORDER BY state`,
        [targetMemberId, firstRoomId],
      )
    ).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ room_role: 'contributor', state: 'active' });
    expect(rows[1]).toMatchObject({ id: original, room_role: 'manager', state: 'revoked' });
    expect(rows[0]?.id).not.toBe(original);
    await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
      targetMemberId,
      JSON.stringify([]),
      JSON.stringify([firstRoomId]),
      ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    expect(
      (
        await migrationPool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM room_assignment
            WHERE member_id=$1 AND room_id=$2 AND state='revoked'`,
          [targetMemberId, firstRoomId],
        )
      ).rows[0]?.count,
    ).toBe(2);
  });

  it('permits many revoked rows but only one active row per room and member', async () => {
    await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
      targetMemberId,
      JSON.stringify([{ roomId: firstRoomId, roomRole: 'manager' }]),
      JSON.stringify([]),
      ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    await expect(
      migrationPool.query(
        "INSERT INTO room_assignment(id,room_id,member_id,room_role,state) VALUES($1,$2,$3,'contributor','active')",
        [createOpaqueId(), firstRoomId, targetMemberId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    for (let cycle = 0; cycle < 2; cycle += 1)
      await migrationPool.query(
        "INSERT INTO room_assignment(id,room_id,member_id,room_role,state) VALUES($1,$2,$3,'contributor','revoked')",
        [createOpaqueId(), firstRoomId, targetMemberId],
      );
    expect(
      (
        await migrationPool.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM room_assignment WHERE member_id=$1 AND room_id=$2',
          [targetMemberId, firstRoomId],
        )
      ).rows[0]?.count,
    ).toBe(3);
  });

  it('never reports a revoked assignment as the reason a room is reachable', async () => {
    await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
      targetMemberId,
      JSON.stringify([{ roomId: firstRoomId, roomRole: 'manager' }]),
      JSON.stringify([]),
      ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    expect(
      (
        await databasePool.query<{ room_role: string; access_source: string }>(
          `SELECT room_role,access_source FROM read_member_rooms($1,NULL,NULL,100)
             WHERE room_id=$2`,
          [targetMemberId, firstRoomId],
        )
      ).rows,
    ).toEqual([{ room_role: 'manager', access_source: 'assignment' }]);
    await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
      targetMemberId,
      JSON.stringify([]),
      JSON.stringify([firstRoomId]),
      ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    expect(
      (
        await databasePool.query(
          'SELECT room_id FROM read_member_rooms($1,NULL,NULL,100) WHERE room_id=$2',
          [targetMemberId, firstRoomId],
        )
      ).rows,
    ).toEqual([]);
    await migrationPool.query(
      "INSERT INTO room_assignment(id,room_id,member_id,room_role,state) VALUES($1,$2,$3,'contributor','revoked')",
      [createOpaqueId(), firstRoomId, ownerId],
    );
    try {
      const roomTitle = (
        await migrationPool.query<{ title: string }>('SELECT title FROM room WHERE id=$1', [
          firstRoomId,
        ])
      ).rows[0]?.title;
      if (roomTitle === undefined) throw new Error('room missing');
      expect(
        (
          await databasePool.query<{ room_role: string | null; access_source: string }>(
            'SELECT room_role,access_source FROM read_member_rooms($1,$2,$3,1)',
            [ownerId, roomTitle, ''],
          )
        ).rows,
      ).toEqual([{ room_role: null, access_source: 'global_role' }]);
    } finally {
      await migrationPool.query('DELETE FROM room_assignment WHERE member_id=$1', [ownerId]);
    }
  });

  it('changes an existing role in place and counts an unchanged role as no change', async () => {
    await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
      targetMemberId,
      JSON.stringify([{ roomId: firstRoomId, roomRole: 'manager' }]),
      JSON.stringify([]),
      ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    const promoted = (
      await databasePool.query<{ apply_room_assignments: { readonly changed: number } }>(
        'SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)',
        [
          targetMemberId,
          JSON.stringify([{ roomId: firstRoomId, roomRole: 'contributor' }]),
          JSON.stringify([]),
          ownerId,
          createOpaqueId(),
          createCorrelationId(),
        ],
      )
    ).rows[0]?.apply_room_assignments;
    expect(promoted?.changed).toBe(1);
    await expect(
      databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
        targetMemberId,
        JSON.stringify([{ roomId: firstRoomId, roomRole: 'contributor' }]),
        JSON.stringify([]),
        ownerId,
        createOpaqueId(),
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '22023' });
    expect(await activeAssignments(targetMemberId)).toEqual([
      { room_id: firstRoomId, room_role: 'contributor' },
    ]);
  });

  it('refuses a plain member, a disabled Admin, a disabled target, and an unknown member', async () => {
    for (const actor of [plainMemberId, disabledAdminId])
      await expect(
        databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
          targetMemberId,
          JSON.stringify([{ roomId: firstRoomId, roomRole: 'manager' }]),
          JSON.stringify([]),
          actor,
          createOpaqueId(),
          createCorrelationId(),
        ]),
      ).rejects.toMatchObject({ code: '42501' });
    for (const target of [disabledMemberId, createOpaqueId()])
      await expect(
        databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
          target,
          JSON.stringify([{ roomId: firstRoomId, roomRole: 'manager' }]),
          JSON.stringify([]),
          ownerId,
          createOpaqueId(),
          createCorrelationId(),
        ]),
      ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses an unknown room with the same denial as an unreachable one', async () => {
    await expect(
      databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
        targetMemberId,
        JSON.stringify([{ roomId: createOpaqueId(), roomRole: 'manager' }]),
        JSON.stringify([]),
        ownerId,
        createOpaqueId(),
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('rejects malformed batch entries without applying the valid ones', async () => {
    for (const [assign, revoke] of [
      [[{ roomId: firstRoomId, roomRole: 'owner' }], []],
      [[{ roomId: firstRoomId, roomRole: 'manager', extra: 'x' }], []],
      [[{ roomId: 'not-an-id', roomRole: 'manager' }], []],
      [[{ roomId: firstRoomId }], []],
      [['a string, not an object'], []],
      [[[firstRoomId, 'manager']], []],
      [
        [
          { roomId: firstRoomId, roomRole: 'manager' },
          { roomId: firstRoomId, roomRole: 'contributor' },
        ],
        [],
      ],
      [[{ roomId: firstRoomId, roomRole: 'manager' }], [firstRoomId]],
      [[{ roomId: secondRoomId, roomRole: 'manager' }], [firstRoomId, firstRoomId]],
      [[{ roomId: firstRoomId, roomRole: 'manager' }], ['not-an-id']],
      [[{ roomId: firstRoomId, roomRole: 'manager' }], [{ roomId: firstRoomId }]],
    ] as const)
      await expect(
        databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
          targetMemberId,
          JSON.stringify(assign),
          JSON.stringify(revoke),
          ownerId,
          createOpaqueId(),
          createCorrelationId(),
        ]),
      ).rejects.toMatchObject({ code: '22023' });
    expect(await activeAssignments(targetMemberId)).toEqual([]);
  });

  it('rejects a non-array batch and an oversized one', async () => {
    for (const [assign, revoke] of [
      ['{"roomId":"x"}', '[]'],
      ['[]', '"not-an-array"'],
      ['[]', 'null'],
    ] as const)
      await expect(
        databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
          targetMemberId,
          assign,
          revoke,
          ownerId,
          createOpaqueId(),
          createCorrelationId(),
        ]),
      ).rejects.toMatchObject({ code: '22023' });
    await expect(
      databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
        targetMemberId,
        JSON.stringify(
          Array.from({ length: 101 }, () => ({
            roomId: createOpaqueId(),
            roomRole: 'manager',
          })),
        ),
        JSON.stringify([]),
        ownerId,
        createOpaqueId(),
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '22023' });
  });

  it('rolls the whole batch back when audit persistence fails', async () => {
    await migrationPool.query(`CREATE FUNCTION fail_assignment_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.event_type='room.assignment' THEN RAISE EXCEPTION 'injected assignment audit failure'; END IF;
        RETURN NEW;
      END $$`);
    await migrationPool.query(
      'CREATE TRIGGER fail_assignment_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION fail_assignment_audit()',
    );
    try {
      await expect(
        databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
          targetMemberId,
          JSON.stringify([
            { roomId: firstRoomId, roomRole: 'manager' },
            { roomId: secondRoomId, roomRole: 'contributor' },
          ]),
          JSON.stringify([]),
          ownerId,
          createOpaqueId(),
          createCorrelationId(),
        ]),
      ).rejects.toThrow('injected assignment audit failure');
      expect(await activeAssignments(targetMemberId)).toEqual([]);
    } finally {
      await migrationPool.query('DROP TRIGGER fail_assignment_audit ON audit_event');
      await migrationPool.query('DROP FUNCTION fail_assignment_audit()');
    }
  });

  it('serializes two batches for one member even when they name different rooms', async () => {
    const first = await databasePool.connect();
    const second = await databasePool.connect();
    try {
      const secondPid = await backendPid(second);
      await first.query('BEGIN');
      await second.query('BEGIN');
      const assign = (
        client: typeof first,
        roomId: string,
      ): Promise<{
        rows: { apply_room_assignments: { readonly assignments: readonly unknown[] } }[];
      }> =>
        client.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
          targetMemberId,
          JSON.stringify([{ roomId, roomRole: 'manager' }]),
          JSON.stringify([]),
          ownerId,
          createOpaqueId(),
          createCorrelationId(),
        ]);
      await assign(first, firstRoomId);
      const pending = assign(second, secondRoomId).then(
        (result) => result,
        (error: unknown) => error,
      );
      await waitUntilBlocked(secondPid);
      await first.query('COMMIT');
      const settled = await pending;
      await second.query('COMMIT');
      expect(
        (settled as { rows: { apply_room_assignments: { assignments: unknown[] } }[] }).rows[0]
          ?.apply_room_assignments.assignments,
      ).toHaveLength(2);
    } finally {
      first.release();
      second.release();
    }
    expect(await activeAssignments(targetMemberId)).toHaveLength(2);
  });

  it('lets exactly one of two simultaneous batches for one room and member succeed', async () => {
    const first = await databasePool.connect();
    const second = await databasePool.connect();
    try {
      const secondPid = await backendPid(second);
      await first.query('BEGIN');
      await second.query('BEGIN');
      const assign = (client: typeof first, role: string): Promise<unknown> =>
        client.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
          targetMemberId,
          JSON.stringify([{ roomId: firstRoomId, roomRole: role }]),
          JSON.stringify([]),
          ownerId,
          createOpaqueId(),
          createCorrelationId(),
        ]);
      await assign(first, 'manager');
      const pending = assign(second, 'contributor').then(
        () => null,
        (error: unknown) => error,
      );
      await waitUntilBlocked(secondPid);
      await first.query('COMMIT');
      expect(await pending).toBeNull();
      await second.query('COMMIT');
    } finally {
      first.release();
      second.release();
    }
    expect(await activeAssignments(targetMemberId)).toEqual([
      { room_id: firstRoomId, room_role: 'contributor' },
    ]);
  });

  it('refuses a batch for a member disabled by a concurrent transaction', async () => {
    const revision = await currentRevision(targetMemberId);
    const disabler = await databasePool.connect();
    const assigner = await databasePool.connect();
    try {
      const assignerPid = await backendPid(assigner);
      await disabler.query('BEGIN');
      await assigner.query('BEGIN');
      await disabler.query('SELECT set_member_state($1,$2,$3,$4,$5,$6)', [
        targetMemberId,
        'disabled',
        ownerId,
        revision,
        createOpaqueId(),
        createCorrelationId(),
      ]);
      const pending = assigner
        .query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
          targetMemberId,
          JSON.stringify([{ roomId: firstRoomId, roomRole: 'manager' }]),
          JSON.stringify([]),
          ownerId,
          createOpaqueId(),
          createCorrelationId(),
        ])
        .then(
          () => null,
          (error: unknown) => error,
        );
      await waitUntilBlocked(assignerPid);
      await disabler.query('COMMIT');
      expect(await pending).toMatchObject({ code: '42501' });
      await assigner.query('ROLLBACK');
    } finally {
      disabler.release();
      assigner.release();
    }
    expect(await activeAssignments(targetMemberId)).toEqual([]);
    await databasePool.query('SELECT set_member_state($1,$2,$3,$4,$5,$6)', [
      targetMemberId,
      'active',
      ownerId,
      revision + 1,
      createOpaqueId(),
      createCorrelationId(),
    ]);
  });

  it('refuses a batch for a member promoted to Admin by a concurrent transaction', async () => {
    const revision = await currentRevision(targetMemberId);
    const promoter = await databasePool.connect();
    const assigner = await databasePool.connect();
    try {
      const assignerPid = await backendPid(assigner);
      await promoter.query('BEGIN');
      await assigner.query('BEGIN');
      await promoter.query('SELECT set_member_global_role($1,$2,$3,$4,$5,$6)', [
        targetMemberId,
        'admin',
        ownerId,
        revision,
        createOpaqueId(),
        createCorrelationId(),
      ]);
      const pending = assigner
        .query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
          targetMemberId,
          JSON.stringify([{ roomId: firstRoomId, roomRole: 'contributor' }]),
          JSON.stringify([]),
          ownerId,
          createOpaqueId(),
          createCorrelationId(),
        ])
        .then(
          () => null,
          (error: unknown) => error,
        );
      await waitUntilBlocked(assignerPid);
      await promoter.query('COMMIT');
      expect(await pending).toMatchObject({ code: '42501' });
      await assigner.query('ROLLBACK');
    } finally {
      promoter.release();
      assigner.release();
    }
    expect(await activeAssignments(targetMemberId)).toEqual([]);
  });
});
