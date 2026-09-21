import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import {
  activeAssignments,
  activeSessionFor,
  backendPid,
  closeAdministrationPools,
  currentRevision,
  databasePool,
  migrationPool,
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
let disposableMemberId: string;
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
    disposableMemberId,
    firstRoomId,
    secondRoomId,
  } = fixture);
});

afterAll(closeAdministrationPools);

describe('set_member_global_role', () => {
  it('promotes a member, revokes their sessions, and audits the transition', async () => {
    const sessionId = await activeSessionFor(targetMemberId);
    const auditId = createOpaqueId();
    const revision = await currentRevision(targetMemberId);
    const next = await databasePool.query<{ set_member_global_role: number }>(
      'SELECT set_member_global_role($1,$2,$3,$4,$5,$6)',
      [targetMemberId, 'admin', ownerId, revision, auditId, createCorrelationId()],
    );
    expect(next.rows[0]?.set_member_global_role).toBe(revision + 1);
    expect(await sessionState(sessionId)).toBe('revoked');
    expect(
      (
        await migrationPool.query<{
          event_type: string;
          reason_code: string;
          actor_id: string;
          subject_id: string;
          detail: Readonly<Record<string, unknown>>;
        }>(
          'SELECT event_type,reason_code,actor_id,subject_id,detail FROM audit_event WHERE id=$1',
          [auditId],
        )
      ).rows[0],
    ).toEqual({
      event_type: 'member.role',
      reason_code: 'MEMBER_ROLE_CHANGED',
      actor_id: ownerId,
      subject_id: targetMemberId,
      detail: { from: 'member', to: 'admin', revision: revision + 1 },
    });
    await databasePool.query('SELECT set_member_global_role($1,$2,$3,$4,$5,$6)', [
      targetMemberId,
      'member',
      ownerId,
      revision + 1,
      createOpaqueId(),
      createCorrelationId(),
    ]);
  });

  it('supersedes active room assignments when promoting a Member to Admin', async () => {
    await migrationPool.query(
      "UPDATE member SET global_role='member',state='active' WHERE id=$1",
      [disposableMemberId],
    );
    await migrationPool.query('DELETE FROM room_assignment WHERE member_id=$1', [
      disposableMemberId,
    ]);
    await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
      disposableMemberId,
      JSON.stringify([
        { roomId: firstRoomId, roomRole: 'manager' },
        { roomId: secondRoomId, roomRole: 'contributor' },
      ]),
      JSON.stringify([]),
      ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    expect(await activeAssignments(disposableMemberId)).toHaveLength(2);

    const correlationId = createCorrelationId();
    const revision = await currentRevision(disposableMemberId);
    await databasePool.query('SELECT set_member_global_role($1,$2,$3,$4,$5,$6)', [
      disposableMemberId,
      'admin',
      ownerId,
      revision,
      createOpaqueId(),
      correlationId,
    ]);
    expect(await activeAssignments(disposableMemberId)).toEqual([]);
    expect(
      (
        await databasePool.query<{ assignments: readonly unknown[] }>(
          `SELECT assignments FROM read_members($1,$2,$3,$4)
            WHERE subject_id=$5`,
          [ownerId, null, null, 100, disposableMemberId],
        )
      ).rows[0]?.assignments,
    ).toEqual([]);
    expect(
      (
        await migrationPool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM room_assignment
            WHERE member_id=$1 AND state='revoked'`,
          [disposableMemberId],
        )
      ).rows[0]?.count,
    ).toBe(2);
    const superseded = (
      await migrationPool.query<{
        reason_code: string;
        actor_id: string;
        subject_id: string;
        detail: Readonly<Record<string, unknown>>;
      }>(
        `SELECT reason_code,actor_id,subject_id,detail FROM audit_event
          WHERE correlation_id=$1 AND event_type='room.assignment'`,
        [correlationId],
      )
    ).rows;
    expect(superseded).toHaveLength(1);
    expect(superseded[0]).toMatchObject({
      reason_code: 'ROOM_ASSIGNMENTS_SUPERSEDED',
      actor_id: ownerId,
      subject_id: disposableMemberId,
    });
    expect(superseded[0]?.detail).toMatchObject({ reason: 'global_role', toRole: 'admin' });
    expect(superseded[0]?.detail['revoked']).toHaveLength(2);

    await databasePool.query('SELECT set_member_global_role($1,$2,$3,$4,$5,$6)', [
      disposableMemberId,
      'member',
      ownerId,
      await currentRevision(disposableMemberId),
      createOpaqueId(),
      createCorrelationId(),
    ]);
    expect(await activeAssignments(disposableMemberId)).toEqual([]);
  });

  it('writes no supersession event when demoting a member who holds nothing', async () => {
    await migrationPool.query("UPDATE member SET global_role='admin' WHERE id=$1", [
      disposableMemberId,
    ]);
    const correlationId = createCorrelationId();
    await databasePool.query('SELECT set_member_global_role($1,$2,$3,$4,$5,$6)', [
      disposableMemberId,
      'member',
      ownerId,
      await currentRevision(disposableMemberId),
      createOpaqueId(),
      correlationId,
    ]);
    expect(
      (
        await migrationPool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM audit_event
            WHERE correlation_id=$1 AND event_type='room.assignment'`,
          [correlationId],
        )
      ).rows[0]?.count,
    ).toBe(0);
  });

  it('admits an Admin as actor', async () => {
    const revision = await currentRevision(disposableMemberId);
    await databasePool.query('SELECT set_member_global_role($1,$2,$3,$4,$5,$6)', [
      disposableMemberId,
      'admin',
      adminId,
      revision,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    await databasePool.query('SELECT set_member_global_role($1,$2,$3,$4,$5,$6)', [
      disposableMemberId,
      'member',
      adminId,
      revision + 1,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    expect(
      (
        await migrationPool.query<{ global_role: string }>(
          'SELECT global_role FROM member WHERE id=$1',
          [disposableMemberId],
        )
      ).rows[0]?.global_role,
    ).toBe('member');
  });

  it('refuses to target the Owner or an unknown member with the same refusal', async () => {
    for (const target of [ownerId, createOpaqueId()])
      await expect(
        databasePool.query('SELECT set_member_global_role($1,$2,$3,$4,$5,$6)', [
          target,
          'admin',
          ownerId,
          1,
          createOpaqueId(),
          createCorrelationId(),
        ]),
      ).rejects.toMatchObject({ code: '42501' });
    expect(
      (
        await migrationPool.query<{ global_role: string }>(
          'SELECT global_role FROM member WHERE id=$1',
          [ownerId],
        )
      ).rows[0]?.global_role,
    ).toBe('owner');
  });

  it('refuses an Admin demoting themselves', async () => {
    await expect(
      databasePool.query('SELECT set_member_global_role($1,$2,$3,$4,$5,$6)', [
        adminId,
        'member',
        adminId,
        await currentRevision(adminId),
        createOpaqueId(),
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('rejects a stale revision and a no-op role, writing no audit row', async () => {
    const before = (
      await migrationPool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM audit_event WHERE event_type='member.role'",
      )
    ).rows[0]?.count;
    await expect(
      databasePool.query('SELECT set_member_global_role($1,$2,$3,$4,$5,$6)', [
        targetMemberId,
        'admin',
        ownerId,
        99,
        createOpaqueId(),
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '40001' });
    await expect(
      databasePool.query('SELECT set_member_global_role($1,$2,$3,$4,$5,$6)', [
        targetMemberId,
        'member',
        ownerId,
        await currentRevision(targetMemberId),
        createOpaqueId(),
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '22023' });
    expect(
      (
        await migrationPool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM audit_event WHERE event_type='member.role'",
        )
      ).rows[0]?.count,
    ).toBe(before);
  });

  it('refuses a plain member and a disabled Admin as actor', async () => {
    for (const actor of [plainMemberId, disabledAdminId])
      await expect(
        databasePool.query('SELECT set_member_global_role($1,$2,$3,$4,$5,$6)', [
          targetMemberId,
          'admin',
          actor,
          await currentRevision(targetMemberId),
          createOpaqueId(),
          createCorrelationId(),
        ]),
      ).rejects.toMatchObject({ code: '42501' });
  });

  it('rejects a role outside the assignable set, including owner', async () => {
    for (const role of ['owner', 'viewer', ''])
      await expect(
        databasePool.query('SELECT set_member_global_role($1,$2,$3,$4,$5,$6)', [
          targetMemberId,
          role,
          ownerId,
          await currentRevision(targetMemberId),
          createOpaqueId(),
          createCorrelationId(),
        ]),
      ).rejects.toMatchObject({ code: '22023' });
  });

  it('rolls the role change back when audit persistence fails', async () => {
    const revision = await currentRevision(targetMemberId);
    await migrationPool.query(`CREATE FUNCTION fail_role_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.event_type='member.role' THEN RAISE EXCEPTION 'injected role audit failure'; END IF;
        RETURN NEW;
      END $$`);
    await migrationPool.query(
      'CREATE TRIGGER fail_role_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION fail_role_audit()',
    );
    try {
      await expect(
        databasePool.query('SELECT set_member_global_role($1,$2,$3,$4,$5,$6)', [
          targetMemberId,
          'admin',
          ownerId,
          revision,
          createOpaqueId(),
          createCorrelationId(),
        ]),
      ).rejects.toThrow('injected role audit failure');
      expect(await currentRevision(targetMemberId)).toBe(revision);
    } finally {
      await migrationPool.query('DROP TRIGGER fail_role_audit ON audit_event');
      await migrationPool.query('DROP FUNCTION fail_role_audit()');
    }
  });

  it('lets exactly one of two simultaneous role changes of one member succeed', async () => {
    const revision = await currentRevision(targetMemberId);
    const first = await databasePool.connect();
    const second = await databasePool.connect();
    try {
      const secondPid = await backendPid(second);
      await first.query('BEGIN');
      await second.query('BEGIN');
      const promote = (client: typeof first): Promise<unknown> =>
        client.query('SELECT set_member_global_role($1,$2,$3,$4,$5,$6)', [
          targetMemberId,
          'admin',
          ownerId,
          revision,
          createOpaqueId(),
          createCorrelationId(),
        ]);
      await promote(first);
      const blocked = promote(second).then(
        () => null,
        (error: unknown) => error,
      );
      await waitUntilBlocked(secondPid);
      await first.query('COMMIT');
      expect(await blocked).toMatchObject({ code: '40001' });
      await second.query('ROLLBACK');
    } finally {
      first.release();
      second.release();
    }
    expect(await currentRevision(targetMemberId)).toBe(revision + 1);
    await databasePool.query('SELECT set_member_global_role($1,$2,$3,$4,$5,$6)', [
      targetMemberId,
      'member',
      ownerId,
      revision + 1,
      createOpaqueId(),
      createCorrelationId(),
    ]);
  });
});

describe('set_member_state', () => {
  it('disables a member, revokes their sessions, and re-enables them', async () => {
    const sessionId = await activeSessionFor(disposableMemberId);
    const revision = await currentRevision(disposableMemberId);
    const auditId = createOpaqueId();
    expect(
      (
        await databasePool.query<{ set_member_state: number }>(
          'SELECT set_member_state($1,$2,$3,$4,$5,$6)',
          [disposableMemberId, 'disabled', ownerId, revision, auditId, createCorrelationId()],
        )
      ).rows[0]?.set_member_state,
    ).toBe(revision + 1);
    expect(
      (
        await migrationPool.query<{ state: string }>('SELECT state FROM member WHERE id=$1', [
          disposableMemberId,
        ])
      ).rows[0]?.state,
    ).toBe('disabled');
    expect(await sessionState(sessionId)).toBe('revoked');
    expect(
      (
        await migrationPool.query<{
          event_type: string;
          reason_code: string;
          detail: Readonly<Record<string, unknown>>;
        }>('SELECT event_type,reason_code,detail FROM audit_event WHERE id=$1', [auditId])
      ).rows[0],
    ).toEqual({
      event_type: 'member.state',
      reason_code: 'MEMBER_STATE_CHANGED',
      detail: { from: 'active', to: 'disabled', revision: revision + 1 },
    });
    await databasePool.query('SELECT set_member_state($1,$2,$3,$4,$5,$6)', [
      disposableMemberId,
      'active',
      ownerId,
      revision + 1,
      createOpaqueId(),
      createCorrelationId(),
    ]);
  });

  it('refuses to disable the Owner with a reason rather than a constraint violation', async () => {
    await expect(
      databasePool.query('SELECT set_member_state($1,$2,$3,$4,$5,$6)', [
        ownerId,
        'disabled',
        ownerId,
        await currentRevision(ownerId),
        createOpaqueId(),
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      databasePool.query('SELECT set_member_state($1,$2,$3,$4,$5,$6)', [
        ownerId,
        'active',
        adminId,
        await currentRevision(ownerId),
        createOpaqueId(),
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    expect(
      (
        await migrationPool.query<{ state: string }>('SELECT state FROM member WHERE id=$1', [
          ownerId,
        ])
      ).rows[0]?.state,
    ).toBe('active');
  });

  it('refuses an Admin disabling themselves and rejects an unknown state', async () => {
    await expect(
      databasePool.query('SELECT set_member_state($1,$2,$3,$4,$5,$6)', [
        adminId,
        'disabled',
        adminId,
        await currentRevision(adminId),
        createOpaqueId(),
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    for (const state of ['invited', 'deleted', ''])
      await expect(
        databasePool.query('SELECT set_member_state($1,$2,$3,$4,$5,$6)', [
          targetMemberId,
          state,
          ownerId,
          await currentRevision(targetMemberId),
          createOpaqueId(),
          createCorrelationId(),
        ]),
      ).rejects.toMatchObject({ code: '22023' });
  });

  it('rejects a stale revision, a no-op state, and a plain member as actor', async () => {
    await expect(
      databasePool.query('SELECT set_member_state($1,$2,$3,$4,$5,$6)', [
        targetMemberId,
        'disabled',
        ownerId,
        99,
        createOpaqueId(),
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '40001' });
    await expect(
      databasePool.query('SELECT set_member_state($1,$2,$3,$4,$5,$6)', [
        targetMemberId,
        'active',
        ownerId,
        await currentRevision(targetMemberId),
        createOpaqueId(),
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      databasePool.query('SELECT set_member_state($1,$2,$3,$4,$5,$6)', [
        targetMemberId,
        'disabled',
        plainMemberId,
        await currentRevision(targetMemberId),
        createOpaqueId(),
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('rolls the state change back when audit persistence fails', async () => {
    const revision = await currentRevision(targetMemberId);
    await migrationPool.query(`CREATE FUNCTION fail_state_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.event_type='member.state' THEN RAISE EXCEPTION 'injected state audit failure'; END IF;
        RETURN NEW;
      END $$`);
    await migrationPool.query(
      'CREATE TRIGGER fail_state_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION fail_state_audit()',
    );
    try {
      await expect(
        databasePool.query('SELECT set_member_state($1,$2,$3,$4,$5,$6)', [
          targetMemberId,
          'disabled',
          ownerId,
          revision,
          createOpaqueId(),
          createCorrelationId(),
        ]),
      ).rejects.toThrow('injected state audit failure');
      expect(
        (
          await migrationPool.query<{ state: string }>('SELECT state FROM member WHERE id=$1', [
            targetMemberId,
          ])
        ).rows[0]?.state,
      ).toBe('active');
    } finally {
      await migrationPool.query('DROP TRIGGER fail_state_audit ON audit_event');
      await migrationPool.query('DROP FUNCTION fail_state_audit()');
    }
  });
});
