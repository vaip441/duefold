import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { generatedMigrations } from '../../.duefold/generated/migrations.ts';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import { FixedClock } from '@duefold/shared/clock';
import { migrate } from '../../modules/core-security/src/db/migrate.ts';
import { issueSession } from '../../modules/core-security/src/sessions.ts';
import { SECURITY_EVENT_TYPES } from '../../modules/core-security/src/audit.ts';

const bootstrapPool = new Pool({
  host: '/var/run/postgresql',
  database: 'duefold_test',
  max: 4,
});
const migrationPool = new Pool({
  connectionString:
    process.env['DUEFOLD_TEST_MIGRATION_DATABASE_URL'] ??
    'postgresql://duefold_migration:duefold_local_migration@127.0.0.1:5432/duefold_test',
  max: 4,
});
const databasePool = new Pool({
  connectionString:
    process.env['DUEFOLD_TEST_DATABASE_URL'] ??
    'postgresql://duefold_runtime:duefold_local_runtime@127.0.0.1:5432/duefold_test',
  max: 4,
});
const authPool = new Pool({
  connectionString:
    process.env['DUEFOLD_TEST_AUTH_DATABASE_URL'] ??
    'postgresql://duefold_authenticator:duefold_local_authenticator@127.0.0.1:5432/duefold_test',
  max: 4,
});

const ownerId = createOpaqueId();
const adminId = createOpaqueId();
const disabledAdminId = createOpaqueId();
const plainMemberId = createOpaqueId();
const targetMemberId = createOpaqueId();
const disposableMemberId = createOpaqueId();
const disabledMemberId = createOpaqueId();
const successorId = createOpaqueId();
const secondSuccessorId = createOpaqueId();
const firstRoomId = createOpaqueId();
const secondRoomId = createOpaqueId();
/* Two further rooms exist only so the assignment reader has enough rows to page
 * through: the bound must be provable on row count, not just on member count. */
const thirdRoomId = createOpaqueId();
const fourthRoomId = createOpaqueId();
/**
 * Rooms for the page-budget tests, which need more than 500 active assignments across
 * several members to force the member list's assignment budget to end a page early.
 * 200 rooms let three members hold 600 between them while each stays under the
 * 500-per-member apply bound, so a truncated-vs-complete distinction is observable.
 */
const bulkRoomIds = Array.from({ length: 200 }, () => createOpaqueId());

async function currentRevision(memberId: string): Promise<number> {
  const row = await migrationPool.query<{ revision: number }>(
    'SELECT revision FROM member WHERE id=$1',
    [memberId],
  );
  const revision = row.rows[0]?.revision;
  if (revision === undefined) throw new Error('member missing');
  return revision;
}

async function activeSessionFor(memberId: string): Promise<string> {
  const issued = await issueSession(
    authPool,
    { kind: 'member', id: memberId, oidcAuthenticatedAt: new Date() },
    'oidc',
    new FixedClock(new Date()),
  );
  return issued.id;
}

async function sessionState(sessionId: string): Promise<string | undefined> {
  return (
    await migrationPool.query<{ state: string }>('SELECT state FROM session WHERE id=$1', [
      sessionId,
    ])
  ).rows[0]?.state;
}

async function activeAssignments(
  memberId: string,
): Promise<readonly { readonly room_id: string; readonly room_role: string }[]> {
  return (
    await migrationPool.query<{ room_id: string; room_role: string }>(
      `SELECT room_id,room_role FROM room_assignment
        WHERE member_id=$1 AND state='active' ORDER BY room_id`,
      [memberId],
    )
  ).rows;
}

async function revokedSessionCount(memberId: string): Promise<number> {
  const count = (
    await migrationPool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM session WHERE member_id=$1 AND state='revoked'",
      [memberId],
    )
  ).rows[0]?.count;
  if (count === undefined) throw new Error('session count unavailable');
  return count;
}

/**
 * Blocks until PostgreSQL reports the given backend as waiting on another
 * transaction. Committing the first transaction before the second has actually
 * reached its lock would test nothing: the second would run afterwards and
 * legitimately succeed, so the contention assertion has to be established rather
 * than assumed from statement order in the test.
 */
async function waitUntilBlocked(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const blocked = (
      await migrationPool.query<{ blocked: boolean }>(
        'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked',
        [pid],
      )
    ).rows[0]?.blocked;
    if (blocked === true) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error('transaction never blocked');
}

async function backendPid(client: { query: Pool['query'] }): Promise<number> {
  const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
    ?.pid;
  if (pid === undefined) throw new Error('backend pid unavailable');
  return pid;
}

beforeAll(async () => {
  await bootstrapPool.query(
    'DROP SCHEMA public CASCADE; CREATE SCHEMA public; ALTER SCHEMA public OWNER TO duefold_migration;',
  );
  await migrate(migrationPool, generatedMigrations);
  const client = await migrationPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO member
       (id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state)
       VALUES
       ($1,'owner@example.test','Owner@example.test','https://issuer.example','owner','owner','active'),
       ($2,'admin@example.test','Admin@example.test','https://issuer.example','admin','admin','active'),
       ($3,'disabled.admin@example.test','Disabled.Admin@example.test','https://issuer.example','disabled-admin','admin','disabled'),
       ($4,'member@example.test','Member@example.test','https://issuer.example','member','member','active'),
       ($5,'target@example.test','Target@example.test','https://issuer.example','target','member','active'),
       ($6,'disposable@example.test','Disposable@example.test','https://issuer.example','disposable','member','active'),
       ($7,'disabled.member@example.test','Disabled.Member@example.test','https://issuer.example','disabled-member','member','disabled'),
       ($8,'successor@example.test','Successor@example.test','https://issuer.example','successor','admin','active'),
       ($9,'second.successor@example.test','Second.Successor@example.test','https://issuer.example','second-successor','member','active')`,
      [
        ownerId,
        adminId,
        disabledAdminId,
        plainMemberId,
        targetMemberId,
        disposableMemberId,
        disabledMemberId,
        successorId,
        secondSuccessorId,
      ],
    );
    await client.query("INSERT INTO organization (id,name) VALUES ($1,'Organization authz')", [
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
    [firstRoomId, 'First assignment room'],
    [secondRoomId, 'Second assignment room'],
    [thirdRoomId, 'Third assignment room'],
    [fourthRoomId, 'Fourth assignment room'],
  ] as const)
    await databasePool.query('SELECT create_room($1,$2,$3,$4,$5,$6)', [
      roomId,
      title,
      '',
      ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);
  /* Titles are zero-padded so the ownership preview's (title, room_id) disclosure
   * order is deterministic and a test can name the row it expects first. */
  for (const [index, roomId] of bulkRoomIds.entries())
    await databasePool.query('SELECT create_room($1,$2,$3,$4,$5,$6)', [
      roomId,
      `Bulk room ${String(index).padStart(3, '0')}`,
      '',
      ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);
});

afterAll(async () => {
  await authPool.end();
  await databasePool.end();
  await migrationPool.end();
  await bootstrapPool.end();
});

describe('invite_member', () => {
  it('admits an Owner, records the intended role, audit event, and onboarding job', async () => {
    const invitationId = createOpaqueId();
    const jobId = createOpaqueId();
    const auditId = createOpaqueId();
    const result = await databasePool.query<{ invite_member: Date }>(
      'SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        invitationId,
        'new.admin@example.test',
        'New.Admin@example.test',
        'admin',
        ownerId,
        jobId,
        auditId,
        createCorrelationId(),
      ],
    );
    expect(result.rows[0]?.invite_member).toBeInstanceOf(Date);

    const invitation = await migrationPool.query<{
      intended_global_role: string;
      invited_by: string;
      state: string;
    }>('SELECT intended_global_role,invited_by,state FROM invitation WHERE id=$1', [
      invitationId,
    ]);
    expect(invitation.rows[0]).toEqual({
      intended_global_role: 'admin',
      invited_by: ownerId,
      state: 'pending',
    });
    const audit = await migrationPool.query<{ event_type: string; reason_code: string }>(
      'SELECT event_type,reason_code FROM audit_event WHERE id=$1',
      [auditId],
    );
    expect(audit.rows[0]).toEqual({
      event_type: 'invitation.created',
      reason_code: 'MEMBER_INVITED',
    });
    const job = await migrationPool.query<{ job_type: string; idempotency_key: string }>(
      'SELECT job_type,idempotency_key FROM job_queue WHERE id=$1',
      [jobId],
    );
    expect(job.rows[0]).toEqual({
      job_type: 'mail.member_invitation',
      idempotency_key: `member-invitation:${invitationId}`,
    });
  });

  it('refuses a plain member', async () => {
    await expect(
      databasePool.query('SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)', [
        createOpaqueId(),
        'forbidden@example.test',
        'forbidden@example.test',
        'member',
        plainMemberId,
        createOpaqueId(),
        createOpaqueId(),
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  /*
   * §4.1 gives Admin "manages members", so an Admin is a first-class actor here
   * and not merely a non-Owner. A disabled Admin is not, because
   * assert_organization_administrator requires an active row.
   */
  it('admits an active Admin as actor and refuses a disabled one', async () => {
    const invitationId = createOpaqueId();
    const auditId = createOpaqueId();
    await databasePool.query('SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)', [
      invitationId,
      'admin-invited@example.test',
      'Admin-invited@example.test',
      'admin',
      adminId,
      createOpaqueId(),
      auditId,
      createCorrelationId(),
    ]);
    expect(
      (
        await migrationPool.query<{ invited_by: string; actor_id: string }>(
          `SELECT i.invited_by,a.actor_id FROM invitation i
             JOIN audit_event a ON a.id=$2 WHERE i.id=$1`,
          [invitationId, auditId],
        )
      ).rows[0],
    ).toEqual({ invited_by: adminId, actor_id: adminId });

    await expect(
      databasePool.query('SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)', [
        createOpaqueId(),
        'disabled-actor@example.test',
        'Disabled-actor@example.test',
        'member',
        disabledAdminId,
        createOpaqueId(),
        createOpaqueId(),
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses an email already held by a member', async () => {
    await expect(
      databasePool.query('SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)', [
        createOpaqueId(),
        'owner@example.test',
        'Owner@example.test',
        'member',
        ownerId,
        createOpaqueId(),
        createOpaqueId(),
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('refuses a second pending invitation for the same address', async () => {
    await databasePool.query('SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)', [
      createOpaqueId(),
      'twice@example.test',
      'Twice@example.test',
      'member',
      ownerId,
      createOpaqueId(),
      createOpaqueId(),
      createCorrelationId(),
    ]);
    await expect(
      databasePool.query('SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)', [
        createOpaqueId(),
        'twice@example.test',
        'Twice@example.test',
        'admin',
        ownerId,
        createOpaqueId(),
        createOpaqueId(),
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '23505' });
  });

  /*
   * 001's UNIQUE (kind, email_key, state) also limited an address to one terminal
   * row, so the second revocation of a re-invited address failed on the unique
   * constraint and the invitation could never be withdrawn.
   */
  it('supports repeated invite and revoke cycles for one address', async () => {
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const invitationId = createOpaqueId();
      await databasePool.query('SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)', [
        invitationId,
        'recycled@example.test',
        'Recycled@example.test',
        'member',
        ownerId,
        createOpaqueId(),
        createOpaqueId(),
        createCorrelationId(),
      ]);
      await databasePool.query('SELECT revoke_member_invitation($1,$2,$3,$4)', [
        invitationId,
        ownerId,
        createOpaqueId(),
        createCorrelationId(),
      ]);
    }
    expect(
      (
        await migrationPool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM invitation
           WHERE email_key='recycled@example.test' AND state='revoked'`,
        )
      ).rows[0]?.count,
    ).toBe(3);
  });

  /*
   * An expired-by-time invitation is already absent from read_members, so it can
   * never be revoked through the surface. Left pending it would hold the address
   * permanently; invite_member closes it before issuing the replacement.
   */
  it('re-invites an address whose earlier invitation lapsed, and marks the lapsed row expired', async () => {
    const lapsedId = createOpaqueId();
    await databasePool.query('SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)', [
      lapsedId,
      'lapsed@example.test',
      'Lapsed@example.test',
      'member',
      ownerId,
      createOpaqueId(),
      createOpaqueId(),
      createCorrelationId(),
    ]);
    await migrationPool.query(
      `UPDATE invitation
       SET created_at = transaction_timestamp() - interval '9 days',
           expires_at = transaction_timestamp() - interval '2 days'
       WHERE id=$1`,
      [lapsedId],
    );

    const replacementId = createOpaqueId();
    const correlationId = createCorrelationId();
    await databasePool.query('SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)', [
      replacementId,
      'lapsed@example.test',
      'Lapsed@example.test',
      'admin',
      ownerId,
      createOpaqueId(),
      createOpaqueId(),
      correlationId,
    ]);
    expect(
      (
        await migrationPool.query<{ id: string; state: string }>(
          `SELECT id,state FROM invitation WHERE email_key='lapsed@example.test'
           ORDER BY state`,
        )
      ).rows,
    ).toEqual([
      { id: lapsedId, state: 'expired' },
      { id: replacementId, state: 'pending' },
    ]);
    /* Expiry is a terminal lifecycle state, so the spine must name the invitation
     * it happened to. The replacement's own invitation.created row identifies only
     * the new invitation and cannot stand in for it. */
    const events = (
      await migrationPool.query<{
        event_type: string;
        actor_id: string;
        resource_id: string;
        reason_code: string;
        detail: Readonly<Record<string, unknown>>;
      }>(
        `SELECT event_type,actor_id,resource_id,reason_code,detail FROM audit_event
          WHERE correlation_id=$1 ORDER BY event_type`,
        [correlationId],
      )
    ).rows;
    expect(
      events.map(({ event_type, actor_id, resource_id, reason_code }) => ({
        event_type,
        actor_id,
        resource_id,
        reason_code,
      })),
    ).toEqual([
      {
        event_type: 'invitation.created',
        actor_id: ownerId,
        resource_id: replacementId,
        reason_code: 'MEMBER_INVITED',
      },
      {
        event_type: 'invitation.expired',
        actor_id: ownerId,
        resource_id: lapsedId,
        reason_code: 'MEMBER_INVITATION_EXPIRED',
      },
    ]);
    expect(events[0]?.detail['intendedRole']).toBe('admin');
    expect(typeof events[0]?.detail['expiresAt']).toBe('string');
    expect(events[1]?.detail).toEqual({ supersededBy: replacementId });
  });

  it('rolls the whole replacement back when the expiry audit fails', async () => {
    const lapsedId = createOpaqueId();
    await databasePool.query('SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)', [
      lapsedId,
      'expiry-rollback@example.test',
      'Expiry-rollback@example.test',
      'member',
      ownerId,
      createOpaqueId(),
      createOpaqueId(),
      createCorrelationId(),
    ]);
    await migrationPool.query(
      `UPDATE invitation
       SET created_at = transaction_timestamp() - interval '9 days',
           expires_at = transaction_timestamp() - interval '2 days'
       WHERE id=$1`,
      [lapsedId],
    );
    await migrationPool.query(`CREATE FUNCTION fail_expiry_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.event_type='invitation.expired' THEN RAISE EXCEPTION 'injected expiry audit failure'; END IF;
        RETURN NEW;
      END $$`);
    await migrationPool.query(
      'CREATE TRIGGER fail_expiry_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION fail_expiry_audit()',
    );
    try {
      const replacementId = createOpaqueId();
      await expect(
        databasePool.query('SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)', [
          replacementId,
          'expiry-rollback@example.test',
          'Expiry-rollback@example.test',
          'member',
          ownerId,
          createOpaqueId(),
          createOpaqueId(),
          createCorrelationId(),
        ]),
      ).rejects.toThrow('injected expiry audit failure');
      /* The lapsed row must stay pending and no replacement may exist: the state
       * change and its evidence commit together or not at all. */
      expect(
        (
          await migrationPool.query<{ id: string; state: string }>(
            "SELECT id,state FROM invitation WHERE email_key='expiry-rollback@example.test'",
          )
        ).rows,
      ).toEqual([{ id: lapsedId, state: 'pending' }]);
    } finally {
      await migrationPool.query('DROP TRIGGER fail_expiry_audit ON audit_event');
      await migrationPool.query('DROP FUNCTION fail_expiry_audit()');
    }
  });

  /*
   * email_key authorizes acceptance and email_display receives the required
   * onboarding mail. If they could disagree, an invitation would admit one address
   * while its mail went to another, so the boundary rejects the pair.
   */
  it('refuses a display address that does not normalize to the authorization key', async () => {
    for (const display of [
      'attacker@example.test',
      'Mismatch@example.test ',
      'mismatch@EXAMPLE.test.evil',
    ]) {
      await expect(
        databasePool.query('SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)', [
          createOpaqueId(),
          'mismatch@example.test',
          display,
          'member',
          ownerId,
          createOpaqueId(),
          createOpaqueId(),
          createCorrelationId(),
        ]),
      ).rejects.toMatchObject({ code: '22023' });
    }
    expect(
      (
        await migrationPool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM invitation WHERE email_key='mismatch@example.test'",
        )
      ).rows[0]?.count,
    ).toBe(0);
  });

  it('accepts a display address that differs from the key only in case', async () => {
    const invitationId = createOpaqueId();
    await databasePool.query('SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)', [
      invitationId,
      'cased@example.test',
      'CaSeD@Example.test',
      'member',
      ownerId,
      createOpaqueId(),
      createOpaqueId(),
      createCorrelationId(),
    ]);
    expect(
      (
        await migrationPool.query<{ email_display: string }>(
          'SELECT email_display FROM invitation WHERE id=$1',
          [invitationId],
        )
      ).rows[0]?.email_display,
    ).toBe('CaSeD@Example.test');
  });

  it('rolls the invitation and job back when audit persistence fails', async () => {
    const invitationId = createOpaqueId();
    const jobId = createOpaqueId();
    await migrationPool.query(`CREATE FUNCTION fail_member_invitation_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.reason_code='MEMBER_INVITED' THEN RAISE EXCEPTION 'injected audit failure'; END IF;
        RETURN NEW;
      END $$`);
    await migrationPool.query(
      'CREATE TRIGGER fail_member_invitation_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION fail_member_invitation_audit()',
    );
    try {
      await expect(
        databasePool.query('SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)', [
          invitationId,
          'rollback@example.test',
          'rollback@example.test',
          'member',
          ownerId,
          jobId,
          createOpaqueId(),
          createCorrelationId(),
        ]),
      ).rejects.toThrow('injected audit failure');
      expect(
        (
          await migrationPool.query<{ count: number }>(
            'SELECT count(*)::int AS count FROM invitation WHERE id=$1',
            [invitationId],
          )
        ).rows[0]?.count,
      ).toBe(0);
      expect(
        (
          await migrationPool.query<{ count: number }>(
            'SELECT count(*)::int AS count FROM job_queue WHERE id=$1',
            [jobId],
          )
        ).rows[0]?.count,
      ).toBe(0);
    } finally {
      await migrationPool.query('DROP TRIGGER fail_member_invitation_audit ON audit_event');
      await migrationPool.query('DROP FUNCTION fail_member_invitation_audit()');
    }
  });
});

describe('revoke_member_invitation', () => {
  it('refuses a plain member and refuses an invitation that is not pending', async () => {
    const invitationId = createOpaqueId();
    await databasePool.query('SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)', [
      invitationId,
      'unrevocable@example.test',
      'Unrevocable@example.test',
      'member',
      ownerId,
      createOpaqueId(),
      createOpaqueId(),
      createCorrelationId(),
    ]);
    await expect(
      databasePool.query('SELECT revoke_member_invitation($1,$2,$3,$4)', [
        invitationId,
        plainMemberId,
        createOpaqueId(),
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await databasePool.query('SELECT revoke_member_invitation($1,$2,$3,$4)', [
      invitationId,
      ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    await expect(
      databasePool.query('SELECT revoke_member_invitation($1,$2,$3,$4)', [
        invitationId,
        ownerId,
        createOpaqueId(),
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '40001' });
  });

  it('revokes a pending invitation with transactional audit', async () => {
    const invitationId = createOpaqueId();
    await databasePool.query('SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)', [
      invitationId,
      'revoked@example.test',
      'revoked@example.test',
      'member',
      ownerId,
      createOpaqueId(),
      createOpaqueId(),
      createCorrelationId(),
    ]);
    const auditId = createOpaqueId();
    await databasePool.query('SELECT revoke_member_invitation($1,$2,$3,$4)', [
      invitationId,
      ownerId,
      auditId,
      createCorrelationId(),
    ]);
    expect(
      (
        await migrationPool.query<{ state: string }>(
          'SELECT state FROM invitation WHERE id=$1',
          [invitationId],
        )
      ).rows[0]?.state,
    ).toBe('revoked');
    expect(
      (
        await migrationPool.query<{ event_type: string; reason_code: string }>(
          'SELECT event_type,reason_code FROM audit_event WHERE id=$1',
          [auditId],
        )
      ).rows[0],
    ).toEqual({
      event_type: 'invitation.revoked',
      reason_code: 'MEMBER_INVITATION_REVOKED',
    });
  });

  it('rolls the revocation back when audit persistence fails', async () => {
    const invitationId = createOpaqueId();
    await databasePool.query('SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)', [
      invitationId,
      'revoke-rollback@example.test',
      'Revoke-rollback@example.test',
      'member',
      ownerId,
      createOpaqueId(),
      createOpaqueId(),
      createCorrelationId(),
    ]);
    await migrationPool.query(`CREATE FUNCTION fail_revocation_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.event_type='invitation.revoked' THEN RAISE EXCEPTION 'injected revocation audit failure'; END IF;
        RETURN NEW;
      END $$`);
    await migrationPool.query(
      'CREATE TRIGGER fail_revocation_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION fail_revocation_audit()',
    );
    try {
      await expect(
        databasePool.query('SELECT revoke_member_invitation($1,$2,$3,$4)', [
          invitationId,
          ownerId,
          createOpaqueId(),
          createCorrelationId(),
        ]),
      ).rejects.toThrow('injected revocation audit failure');
      expect(
        (
          await migrationPool.query<{ state: string }>(
            'SELECT state FROM invitation WHERE id=$1',
            [invitationId],
          )
        ).rows[0]?.state,
      ).toBe('pending');
    } finally {
      await migrationPool.query('DROP TRIGGER fail_revocation_audit ON audit_event');
      await migrationPool.query('DROP FUNCTION fail_revocation_audit()');
    }
  });
});

/*
 * Two Admins acting at the same instant must not both succeed. The explicit
 * pending check inside invite_member is not itself a serialization point, so
 * one_pending_invitation is the backstop that decides the winner.
 */
describe('concurrent organization administration', () => {
  it('admits exactly one of two simultaneous invitations for one address', async () => {
    const first = await databasePool.connect();
    const second = await databasePool.connect();
    try {
      await first.query('BEGIN');
      await second.query('BEGIN');
      const invite = (client: typeof first): Promise<unknown> =>
        client.query('SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)', [
          createOpaqueId(),
          'contended@example.test',
          'Contended@example.test',
          'member',
          ownerId,
          createOpaqueId(),
          createOpaqueId(),
          createCorrelationId(),
        ]);
      await invite(first);
      const blocked = invite(second).then(
        () => null,
        (error: unknown) => error,
      );
      await first.query('COMMIT');
      expect(await blocked).toBeInstanceOf(Error);
      await second.query('ROLLBACK');
    } finally {
      first.release();
      second.release();
    }
    expect(
      (
        await migrationPool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM invitation
            WHERE email_key='contended@example.test' AND state='pending'`,
        )
      ).rows[0]?.count,
    ).toBe(1);
  });

  it('lets exactly one of two simultaneous revocations of one invitation succeed', async () => {
    const invitationId = createOpaqueId();
    await databasePool.query('SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)', [
      invitationId,
      'contended-revoke@example.test',
      'Contended-revoke@example.test',
      'member',
      ownerId,
      createOpaqueId(),
      createOpaqueId(),
      createCorrelationId(),
    ]);
    const first = await databasePool.connect();
    const second = await databasePool.connect();
    try {
      await first.query('BEGIN');
      await second.query('BEGIN');
      const revoke = (client: typeof first): Promise<unknown> =>
        client.query('SELECT revoke_member_invitation($1,$2,$3,$4)', [
          invitationId,
          ownerId,
          createOpaqueId(),
          createCorrelationId(),
        ]);
      await revoke(first);
      /* The second transaction blocks on the same row and, once the first commits,
       * must see a non-pending invitation rather than double-revoking it. */
      const blocked = revoke(second).then(
        () => null,
        (error: unknown) => error,
      );
      await first.query('COMMIT');
      expect(await blocked).toMatchObject({ code: '40001' });
      await second.query('ROLLBACK');
    } finally {
      first.release();
      second.release();
    }
    expect(
      (
        await migrationPool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM audit_event
            WHERE resource_id=$1 AND event_type='invitation.revoked'`,
          [invitationId],
        )
      ).rows[0]?.count,
    ).toBe(1);
  });
});

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

  /*
   * Members and pending invitations both grow, so §23 requires a bounded, keyset-paged
   * reader rather than a full projection. The page size is enforced in SQL, not only
   * in the route, because the route is not the authority.
   */
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
    /* 100 is the whole bound. The continuation probe is now the reader's own internal
     * row rather than something a caller asks for, so 101 is no longer reachable and
     * the SQL bound matches the client-visible one exactly. */
    await expect(
      databasePool.query('SELECT * FROM read_members($1,$2,$3,$4)', [ownerId, null, null, 100]),
    ).resolves.toBeDefined();
  });

  /* Half a cursor would page from an arbitrary point, so it is refused rather than
   * completed by a guess. */
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

  /*
   * Paging must be total and lossless. created_at alone is not unique -- several
   * subjects are seeded in one transaction and share an instant -- so the cursor
   * carries the subject id as a tiebreaker. Walking one row at a time visits every
   * subject exactly once; without the tiebreaker rows sharing an instant would be
   * skipped or repeated.
   */
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
    // Several subjects genuinely share an instant, which is what makes the
    // tiebreaker load-bearing rather than theoretical.
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

  /*
   * The cursor must survive the round trip a client actually performs.
   * timestamptz holds microseconds and a JavaScript Date holds milliseconds, so
   * paging on a parsed-and-reserialized instant moves the cursor EARLIER than the
   * row it came from and, in descending order, silently drops every subject tied at
   * that microsecond. This asserts the exact text is lossless and demonstrates the
   * truncation it avoids.
   */
  it('pages losslessly on the exact server timestamp a truncated one would skip', async () => {
    const all = (
      await databasePool.query<{ subject_id: string; cursor_created_at: string }>(
        'SELECT subject_id,cursor_created_at FROM read_members($1,$2,$3,$4)',
        [ownerId, null, null, 100],
      )
    ).rows;
    /* A row that has at least one SUCCESSOR sharing its exact instant, so paging
     * past it is precisely the case truncation breaks. The seed inserts several
     * members in one transaction, so such a row exists. */
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
    // The exact cursor resumes immediately after the pivot: nothing skipped.
    expect(remaining.map(({ subject_id }) => subject_id)).toEqual(
      all.slice(index + 1).map(({ subject_id }) => subject_id),
    );

    /* The same cursor after a Date round trip. timestamptz carries microseconds and
     * Date carries milliseconds, so the instant moves earlier and, in descending
     * order, every subject still tied at that microsecond is silently dropped. */
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
    /* 001's member_privilege_session_revoke is the single place a privilege change
     * ends sessions. This asserts it actually fires through this path rather than
     * trusting that the function remembered to duplicate it. */
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
    // Restored so later cases see the seeded plain-member role.
    await databasePool.query('SELECT set_member_global_role($1,$2,$3,$4,$5,$6)', [
      targetMemberId,
      'member',
      ownerId,
      revision + 1,
      createOpaqueId(),
      createCorrelationId(),
    ]);
  });

  /*
   * §4.2 gives Owners and Admins Room Manager authority in every room, and
   * apply_room_assignments accepts only plain Members as targets. Promotion must
   * therefore not leave the rows behind: the list would advertise a narrower
   * 'contributor' row on someone holding standing Manager rights, and a later
   * demotion would make those stale rows authorization-effective again with no
   * room.assignment mutation and no audit row naming the change.
   */
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
    // No active assignment survives the promotion, so the list cannot advertise one.
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
    /* Revocation, not deletion: the terminal rows remain so the assignment
     * lifecycle stays reconstructable, exactly as apply_room_assignments does it. */
    expect(
      (
        await migrationPool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM room_assignment
            WHERE member_id=$1 AND state='revoked'`,
          [disposableMemberId],
        )
      ).rows[0]?.count,
    ).toBe(2);
    /* §15.1: a privilege set changed, so the spine names it. The event shares the
     * caller's correlation id, so the role change and its effect read as one action. */
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

    /* The sequential case the previous suite missed: demoting back must NOT restore
     * access, because the rows are gone rather than merely shadowed by the role. */
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

  /* A demotion grants nothing, so it writes no supersession event. Asserted so the
   * helper cannot start firing on a direction where it would be noise. */
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

  /*
   * The Owner is untargetable here so one audited path -- transfer_ownership --
   * owns the single-owner invariant. An unknown id is refused identically, so a
   * denial cannot be used to discover which member ids exist.
   */
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

  /*
   * Self-administration destroys the acting session mid-request and can reduce
   * the installation's administration capacity by accident. The Owner remains
   * able to do it, so the capability is not lost.
   */
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
    /* "member to member" is evidence of a change that never happened, and the
     * revision bump would invalidate every other client's view for nothing. */
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
      /* The second transaction blocks on the locked member row and, once the
       * first commits, must observe the new revision rather than overwrite it. */
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

  /*
   * Disabling the Owner would leave no active Owner and surface as a deferred
   * constraint-trigger violation at COMMIT, which no surface can explain.
   */
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
    // Re-activating the Owner is equally refused; the Owner is not state-targetable.
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

/*
 * Every transfer case consumes the current Owner, so each one reseeds ownership
 * from scratch. exactly_one_owner_after_member is deferred to COMMIT, so the
 * demote-then-promote pair is legal inside one transaction; one_active_owner is a
 * partial unique index and is not, which is what the ordering test below proves.
 */
describe('transfer_ownership', () => {
  const freshAuthentication = (): Date => new Date();

  /**
   * Issues the server-recorded preview that apply must present.
   *
   * Every legitimate transfer goes through this, because the confirmation phrase
   * alone is a public constant and no longer sufficient.
   */
  async function issuePreview(
    targetId: string,
    actorId: string = ownerId,
  ): Promise<{
    readonly previewId: string;
    readonly confirmation: string;
    readonly expectedRevision: number;
  }> {
    const previewId = createOpaqueId();
    const impact = (
      await databasePool.query<{
        dry_run_ownership_transfer: {
          readonly previewId: string;
          readonly confirmation: string;
          readonly expectedRevision: number;
        };
      }>('SELECT dry_run_ownership_transfer($1,$2,$3)', [previewId, targetId, actorId])
    ).rows[0]?.dry_run_ownership_transfer;
    if (impact === undefined) throw new Error('preview missing');
    return {
      previewId: impact.previewId,
      confirmation: impact.confirmation,
      expectedRevision: impact.expectedRevision,
    };
  }

  beforeEach(async () => {
    const client = await migrationPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "UPDATE member SET global_role='admin' WHERE global_role='owner' AND id<>$1",
        [ownerId],
      );
      await client.query("UPDATE member SET global_role='owner',state='active' WHERE id=$1", [
        ownerId,
      ]);
      await client.query("UPDATE member SET global_role='admin',state='active' WHERE id=$1", [
        successorId,
      ]);
      await client.query("UPDATE member SET global_role='member',state='active' WHERE id=$1", [
        secondSuccessorId,
      ]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  it('previews the impact and moves ownership, demoting the outgoing Owner to admin', async () => {
    const previewId = createOpaqueId();
    const impact = (
      await databasePool.query<{
        dry_run_ownership_transfer: {
          readonly previewId: string;
          readonly targetEmailDisplay: string;
          readonly confirmation: string;
          readonly message: string;
          readonly expectedRevision: number;
        };
      }>('SELECT dry_run_ownership_transfer($1,$2,$3)', [previewId, successorId, ownerId])
    ).rows[0]?.dry_run_ownership_transfer;
    expect(impact?.confirmation).toBe('TRANSFER OWNERSHIP');
    expect(impact?.targetEmailDisplay).toBe('Successor@example.test');
    expect(impact?.message).toContain('signed out of every device');
    /* The preview echoes its own id and the revision it describes, so apply can
     * prove which dry run it followed. */
    expect(impact?.previewId).toBe(previewId);
    expect(impact?.expectedRevision).toBe(await currentRevision(successorId));

    const auditId = createOpaqueId();
    await databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
      successorId,
      ownerId,
      impact?.expectedRevision,
      freshAuthentication(),
      previewId,
      'TRANSFER OWNERSHIP',
      auditId,
      createCorrelationId(),
    ]);
    const roles = new Map(
      (
        await migrationPool.query<{ id: string; global_role: string }>(
          'SELECT id,global_role FROM member WHERE id = ANY($1)',
          [[ownerId, successorId]],
        )
      ).rows.map(({ id, global_role }) => [id, global_role]),
    );
    expect(roles.get(successorId)).toBe('owner');
    expect(roles.get(ownerId)).toBe('admin');
    const audit = (
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
    ).rows[0];
    expect(audit).toMatchObject({
      event_type: 'ownership.transferred',
      reason_code: 'OWNERSHIP_TRANSFERRED',
      actor_id: ownerId,
      subject_id: successorId,
    });
    /* §20.3: the spine names roles and revisions, never the address. The Owner
     * read the address in the dry run; it does not belong in audit detail. */
    expect(JSON.stringify(audit?.detail)).not.toContain('@');
  });

  /*
   * Ownership carries standing Room Manager authority in every room (§4.2), so an
   * explicit assignment the successor held is superseded by the promotion. Without
   * this, the new Owner kept a 'contributor' row that the list would advertise and
   * that a later demotion would silently reactivate.
   */
  it('supersedes the successor\u2019s room assignments when promoting them to Owner', async () => {
    await migrationPool.query('DELETE FROM room_assignment WHERE member_id=$1', [
      secondSuccessorId,
    ]);
    await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
      secondSuccessorId,
      JSON.stringify([{ roomId: firstRoomId, roomRole: 'contributor' }]),
      JSON.stringify([]),
      ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    expect(await activeAssignments(secondSuccessorId)).toHaveLength(1);

    const preview = await issuePreview(secondSuccessorId);
    const correlationId = createCorrelationId();
    await databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
      secondSuccessorId,
      ownerId,
      preview.expectedRevision,
      freshAuthentication(),
      preview.previewId,
      preview.confirmation,
      createOpaqueId(),
      correlationId,
    ]);
    expect(
      (
        await migrationPool.query<{ global_role: string }>(
          'SELECT global_role FROM member WHERE id=$1',
          [secondSuccessorId],
        )
      ).rows[0]?.global_role,
    ).toBe('owner');
    expect(await activeAssignments(secondSuccessorId)).toEqual([]);
    /* Both the transfer and its assignment effect share one correlation id, so the
     * spine reads as a single administrative action. */
    const events = (
      await migrationPool.query<{ event_type: string; reason_code: string }>(
        `SELECT event_type,reason_code FROM audit_event
          WHERE correlation_id=$1 ORDER BY event_type`,
        [correlationId],
      )
    ).rows;
    expect(events).toEqual([
      { event_type: 'ownership.transferred', reason_code: 'OWNERSHIP_TRANSFERRED' },
      { event_type: 'room.assignment', reason_code: 'ROOM_ASSIGNMENTS_SUPERSEDED' },
    ]);
  });

  it('revokes both members\u2019 sessions because both privilege rows changed', async () => {
    const ownerSession = await activeSessionFor(ownerId);
    const successorSession = await activeSessionFor(successorId);
    const preview = await issuePreview(successorId);
    await databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
      successorId,
      ownerId,
      preview.expectedRevision,
      freshAuthentication(),
      preview.previewId,
      preview.confirmation,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    expect(await sessionState(ownerSession)).toBe('revoked');
    expect(await sessionState(successorSession)).toBe('revoked');
  });

  it('refuses a mismatched confirmation, including a case variant', async () => {
    for (const confirmation of ['transfer ownership', 'TRANSFER  OWNERSHIP', '']) {
      /* A fresh, valid preview each time, so the refusal is provably the typed
       * phrase rather than a missing preview. */
      const preview = await issuePreview(successorId);
      await expect(
        databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
          successorId,
          ownerId,
          preview.expectedRevision,
          freshAuthentication(),
          preview.previewId,
          confirmation,
          createOpaqueId(),
          createCorrelationId(),
        ]),
      ).rejects.toMatchObject({ code: '22023' });
    }
    expect(
      (
        await migrationPool.query<{ global_role: string }>(
          'SELECT global_role FROM member WHERE id=$1',
          [ownerId],
        )
      ).rows[0]?.global_role,
    ).toBe('owner');
  });

  /* §9.4 makes ownership a high-consequence change, so the authoritative
   * freshness decision is here rather than advisory in the route. */
  it('refuses an absent, future, or stale authentication instant', async () => {
    for (const authenticatedAt of [
      null,
      new Date(Date.now() + 60_000),
      new Date(Date.now() - 16 * 60_000),
    ]) {
      const preview = await issuePreview(successorId);
      await expect(
        databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
          successorId,
          ownerId,
          preview.expectedRevision,
          authenticatedAt,
          preview.previewId,
          preview.confirmation,
          createOpaqueId(),
          createCorrelationId(),
        ]),
      ).rejects.toThrow('fresh OIDC required');
    }
  });

  it('refuses an Admin who is not the Owner, and a plain member', async () => {
    /* Neither may obtain a preview of their own, so each is also given the Owner's
     * preview to prove a stolen one does not transfer authority. */
    const ownerPreview = await issuePreview(secondSuccessorId);
    for (const actor of [successorId, plainMemberId]) {
      await expect(
        databasePool.query('SELECT dry_run_ownership_transfer($1,$2,$3)', [
          createOpaqueId(),
          secondSuccessorId,
          actor,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
          secondSuccessorId,
          actor,
          ownerPreview.expectedRevision,
          freshAuthentication(),
          ownerPreview.previewId,
          ownerPreview.confirmation,
          createOpaqueId(),
          createCorrelationId(),
        ]),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('refuses a disabled target, the Owner themselves, and an unknown member', async () => {
    const otherPreview = await issuePreview(successorId);
    for (const target of [disabledMemberId, ownerId, createOpaqueId()]) {
      await expect(
        databasePool.query('SELECT dry_run_ownership_transfer($1,$2,$3)', [
          createOpaqueId(),
          target,
          ownerId,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      /* A preview naming a DIFFERENT target must not admit this one: the preview is
       * bound to the target it described. */
      await expect(
        databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
          target,
          ownerId,
          otherPreview.expectedRevision,
          freshAuthentication(),
          otherPreview.previewId,
          otherPreview.confirmation,
          createOpaqueId(),
          createCorrelationId(),
        ]),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('rejects a stale target revision', async () => {
    const preview = await issuePreview(successorId);
    await expect(
      databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
        successorId,
        ownerId,
        preview.expectedRevision + 5,
        freshAuthentication(),
        preview.previewId,
        preview.confirmation,
        createOpaqueId(),
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '40001' });
  });

  it('rolls the whole transfer back when audit persistence fails', async () => {
    await migrationPool.query(`CREATE FUNCTION fail_transfer_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.event_type='ownership.transferred' THEN RAISE EXCEPTION 'injected transfer audit failure'; END IF;
        RETURN NEW;
      END $$`);
    await migrationPool.query(
      'CREATE TRIGGER fail_transfer_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION fail_transfer_audit()',
    );
    try {
      const preview = await issuePreview(successorId);
      await expect(
        databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
          successorId,
          ownerId,
          preview.expectedRevision,
          freshAuthentication(),
          preview.previewId,
          preview.confirmation,
          createOpaqueId(),
          createCorrelationId(),
        ]),
      ).rejects.toThrow('injected transfer audit failure');
      const roles = new Map(
        (
          await migrationPool.query<{ id: string; global_role: string }>(
            'SELECT id,global_role FROM member WHERE id = ANY($1)',
            [[ownerId, successorId]],
          )
        ).rows.map(({ id, global_role }) => [id, global_role]),
      );
      expect(roles.get(ownerId)).toBe('owner');
      expect(roles.get(successorId)).toBe('admin');
    } finally {
      await migrationPool.query('DROP TRIGGER fail_transfer_audit ON audit_event');
      await migrationPool.query('DROP FUNCTION fail_transfer_audit()');
    }
  });

  /*
   * The ordering comment inside transfer_ownership is load-bearing. This asserts
   * the constraint it describes, so a future reordering fails loudly here rather
   * than intermittently in production.
   */
  it('cannot hold two active owners even momentarily', async () => {
    await expect(
      migrationPool.query("UPDATE member SET global_role='owner' WHERE id=$1", [successorId]),
    ).rejects.toMatchObject({ code: '23505' });
  });

  /*
   * §9.4 requires a dry run before a high-consequence change. The confirmation
   * phrase is a constant this repository documents, so comparing a caller's input
   * against it proved only that the caller could read the docs. Apply therefore
   * consumes a server-issued preview, and these are the cases that must fail.
   */
  it('refuses an apply that never previewed, even with the correct phrase', async () => {
    await expect(
      databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
        successorId,
        ownerId,
        await currentRevision(successorId),
        freshAuthentication(),
        createOpaqueId(),
        'TRANSFER OWNERSHIP',
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

  it('spends a preview exactly once', async () => {
    const preview = await issuePreview(successorId);
    const apply = (): Promise<unknown> =>
      databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
        successorId,
        ownerId,
        preview.expectedRevision,
        freshAuthentication(),
        preview.previewId,
        preview.confirmation,
        createOpaqueId(),
        createCorrelationId(),
      ]);
    await apply();
    /* Reuse is refused even though the row is retained: consumed_at is set, and the
     * evidence that a preview preceded this transfer survives beside the audit. */
    await expect(apply()).rejects.toMatchObject({ code: '42501' });
    expect(
      (
        await migrationPool.query<{ consumed: boolean }>(
          'SELECT consumed_at IS NOT NULL AS consumed FROM ownership_transfer_preview WHERE id=$1',
          [preview.previewId],
        )
      ).rows[0]?.consumed,
    ).toBe(true);
  });

  it('refuses a lapsed preview', async () => {
    const preview = await issuePreview(successorId);
    await migrationPool.query(
      `UPDATE ownership_transfer_preview
       SET created_at = statement_timestamp() - interval '30 minutes',
           expires_at = statement_timestamp() - interval '15 minutes'
       WHERE id=$1`,
      [preview.previewId],
    );
    await expect(
      databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
        successorId,
        ownerId,
        preview.expectedRevision,
        freshAuthentication(),
        preview.previewId,
        preview.confirmation,
        createOpaqueId(),
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  /* The preview describes an impact at one revision. A target that changed since
   * then means the Owner agreed to something that no longer holds. */
  it('refuses a preview whose target changed after it was issued', async () => {
    const preview = await issuePreview(secondSuccessorId);
    await databasePool.query('SELECT set_member_global_role($1,$2,$3,$4,$5,$6)', [
      secondSuccessorId,
      'admin',
      ownerId,
      preview.expectedRevision,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    await expect(
      databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
        secondSuccessorId,
        ownerId,
        await currentRevision(secondSuccessorId),
        freshAuthentication(),
        preview.previewId,
        preview.confirmation,
        createOpaqueId(),
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '40001' });
  });

  /* The preview table is definer-only state. A web credential that could write it
   * could mint its own evidence, which would defeat the gate entirely. */
  it('keeps the preview record unreachable from every application role', async () => {
    for (const statement of [
      'SELECT * FROM ownership_transfer_preview',
      "INSERT INTO ownership_transfer_preview(id,actor_id,target_id,target_revision,target_assignment_digest,impact,expires_at) VALUES ('x','y','z',1,repeat('0',64),'{}'::jsonb,statement_timestamp())",
      'DELETE FROM ownership_transfer_preview',
    ])
      await expect(databasePool.query(statement)).rejects.toMatchObject({ code: '42501' });
  });

  /*
   * §4.2 gives the Owner standing Room Manager authority everywhere, so promoting the
   * successor supersedes every explicit assignment they hold. The dry run must NAME
   * that loss: a preview describing only the role change asked the Owner to approve a
   * privilege revocation it never mentioned, and a typed phrase cannot consent to
   * something that was never shown.
   */
  it('discloses the assignments the promotion will revoke, with rooms the Owner may see', async () => {
    await migrationPool.query(
      "UPDATE member SET global_role='member',state='active' WHERE id=$1",
      [secondSuccessorId],
    );
    await migrationPool.query('DELETE FROM room_assignment WHERE member_id=$1', [
      secondSuccessorId,
    ]);
    await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
      secondSuccessorId,
      JSON.stringify([
        { roomId: firstRoomId, roomRole: 'manager' },
        { roomId: secondRoomId, roomRole: 'contributor' },
      ]),
      JSON.stringify([]),
      ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    const impact = (
      await databasePool.query<{
        dry_run_ownership_transfer: {
          readonly revokedAssignmentCount: number;
          readonly revokedAssignments: readonly {
            readonly roomId: string;
            readonly roomTitle: string;
            readonly roomRole: string;
          }[];
          readonly revokedAssignmentsTruncated: boolean;
        };
      }>('SELECT dry_run_ownership_transfer($1,$2,$3)', [
        createOpaqueId(),
        secondSuccessorId,
        ownerId,
      ])
    ).rows[0]?.dry_run_ownership_transfer;
    expect(impact?.revokedAssignmentCount).toBe(2);
    expect(impact?.revokedAssignmentsTruncated).toBe(false);
    /* Room titles, not just ids: "two assignments will be revoked" is not a decision
     * the Owner can make. Disclosed because the Owner already holds Room Manager
     * authority in every room, so nothing named here is newly visible to them. */
    expect(impact?.revokedAssignments).toEqual([
      {
        roomId: firstRoomId,
        roomTitle: 'First assignment room',
        roomRole: 'manager',
      },
      {
        roomId: secondRoomId,
        roomTitle: 'Second assignment room',
        roomRole: 'contributor',
      },
    ]);
  });

  /* A successor holding nothing is the ordinary case, and it must read as "no rooms
   * affected" rather than as an absent or unknown answer. */
  it('reports an empty, non-truncated impact for an unassigned successor', async () => {
    await migrationPool.query('DELETE FROM room_assignment WHERE member_id=$1', [successorId]);
    const impact = (
      await databasePool.query<{
        dry_run_ownership_transfer: {
          readonly revokedAssignmentCount: number;
          readonly revokedAssignments: readonly unknown[];
          readonly revokedAssignmentsTruncated: boolean;
        };
      }>('SELECT dry_run_ownership_transfer($1,$2,$3)', [
        createOpaqueId(),
        successorId,
        ownerId,
      ])
    ).rows[0]?.dry_run_ownership_transfer;
    expect(impact).toMatchObject({
      revokedAssignmentCount: 0,
      revokedAssignments: [],
      revokedAssignmentsTruncated: false,
    });
  });

  /* The named list is bounded because it carries titles, and the count stays exact.
   * `revokedAssignmentsTruncated` says when the list ran short, so a preview cannot
   * understate the revocation by listing fewer rooms than it will take away. The
   * member list carries any one member's complete set, so the rest is reachable. */
  it('bounds the named rooms while keeping the count exact', async () => {
    await migrationPool.query(
      "UPDATE member SET global_role='member',state='active' WHERE id=$1",
      [secondSuccessorId],
    );
    await migrationPool.query('DELETE FROM room_assignment WHERE member_id=$1', [
      secondSuccessorId,
    ]);
    for (let offset = 0; offset < bulkRoomIds.length; offset += 100)
      await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
        secondSuccessorId,
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
    const impact = (
      await databasePool.query<{
        dry_run_ownership_transfer: {
          readonly revokedAssignmentCount: number;
          readonly revokedAssignments: readonly { readonly roomTitle: string }[];
          readonly revokedAssignmentsTruncated: boolean;
        };
      }>('SELECT dry_run_ownership_transfer($1,$2,$3)', [
        createOpaqueId(),
        secondSuccessorId,
        ownerId,
      ])
    ).rows[0]?.dry_run_ownership_transfer;
    expect(impact?.revokedAssignmentCount).toBe(bulkRoomIds.length);
    expect(impact?.revokedAssignments).toHaveLength(100);
    expect(impact?.revokedAssignmentsTruncated).toBe(true);
    // Ordered by title, so the disclosed subset is the first rooms and not an arbitrary one.
    expect(impact?.revokedAssignments[0]?.roomTitle).toBe('Bulk room 000');
    await migrationPool.query('DELETE FROM room_assignment WHERE member_id=$1', [
      secondSuccessorId,
    ]);
  });

  /*
   * The preview must not be able to DISCLOSE one assignment set while STORING the
   * digest of another.
   *
   * This is a narrower window than the test below, and the digest alone did not close
   * it. The dry run used to derive the disclosed rooms in one statement, the revision in
   * a second, and the digest in a third, with no lock spanning them. Under READ
   * COMMITTED each statement takes its own snapshot, so apply_room_assignments could
   * commit BETWEEN them: the Owner was shown set A while the preview stored a digest for
   * set B. Apply then locked the target, recomputed the digest, found B, matched the
   * stored value, and revoked rooms that were never disclosed -- the exact-set fence
   * defeated by the evidence meant to enforce it, and undetectable at apply time because
   * both halves of the preview looked mutually consistent by then.
   *
   * The dry run now takes the target's member row lock -- the same serialization point
   * apply_room_assignments takes before it validates or writes anything -- and derives
   * everything from ONE call to member_assignment_impact under it.
   *
   * THE MUTATION IS FIRED WHILE THE PREVIEW IS STILL EXECUTING, which is what makes this
   * a regression rather than a restatement of the test below. Awaiting the preview first
   * would only prove that a mutation AFTER a completed preview is caught, and that
   * passes even against the vulnerable three-statement version.
   *
   * The invariant is asserted on the STORED EVIDENCE, not on timing: whatever order the
   * two transactions happen to resolve in, the digest the preview stored must describe
   * the set it disclosed. Against the old shape this failed -- disclosed one room while
   * the stored digest already matched the two-room set.
   */
  it('cannot disclose one assignment set while storing another\u2019s digest', async () => {
    await migrationPool.query(
      "UPDATE member SET global_role='member',state='active' WHERE id=$1",
      [secondSuccessorId],
    );
    await migrationPool.query('DELETE FROM room_assignment WHERE member_id=$1', [
      secondSuccessorId,
    ]);
    await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
      secondSuccessorId,
      JSON.stringify([{ roomId: firstRoomId, roomRole: 'manager' }]),
      JSON.stringify([]),
      ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);

    const previewId = createOpaqueId();
    /* Deliberately NOT awaited: the staffing change below is issued while this is still
     * running, so it lands in the window between the disclosure and the digest capture
     * that the old implementation left open. */
    const inFlightPreview = databasePool
      .query<{
        dry_run_ownership_transfer: {
          readonly revokedAssignmentCount: number;
          readonly revokedAssignments: readonly { readonly roomId: string }[];
        };
      }>('SELECT dry_run_ownership_transfer($1,$2,$3)', [previewId, secondSuccessorId, ownerId])
      .then(({ rows }) => rows[0]?.dry_run_ownership_transfer);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
      secondSuccessorId,
      JSON.stringify([{ roomId: secondRoomId, roomRole: 'contributor' }]),
      JSON.stringify([]),
      ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    const disclosed = await inFlightPreview;
    expect(await activeAssignments(secondSuccessorId)).toHaveLength(2);

    /*
     * THE INVARIANT. The stored digest must describe exactly the set the preview
     * disclosed. The lock makes the preview and the batch serialize, so the disclosure is
     * either the one-room set (preview won) or the two-room set (batch won) -- but never
     * one of those paired with the other's digest, which is what the old code produced.
     */
    const stored = (
      await migrationPool.query<{
        impact: {
          readonly revokedAssignmentCount: number;
          readonly revokedAssignments: readonly { readonly roomId: string }[];
        };
        target_assignment_digest: string;
        target_revision: number;
      }>(
        `SELECT impact,target_assignment_digest,target_revision
           FROM ownership_transfer_preview WHERE id=$1`,
        [previewId],
      )
    ).rows[0];
    if (stored === undefined) throw new Error('preview row missing');
    // What the caller read and what the server recorded are the same disclosure.
    expect(disclosed?.revokedAssignmentCount).toBe(stored.impact.revokedAssignmentCount);
    /* The digest of exactly the disclosed rooms, recomputed independently here. A digest
     * bound to any other set fails this regardless of which transaction won the race. */
    const disclosedRooms = stored.impact.revokedAssignments.map(({ roomId }) => roomId);
    const digestOfDisclosed = (
      await migrationPool.query<{ digest: string }>(
        `SELECT encode(sha256(convert_to(coalesce(string_agg(
             a.id || ':' || a.room_id || ':' || a.room_role, E'\\n' ORDER BY a.room_id), ''),
           'UTF8')),'hex') AS digest
         FROM room_assignment a
         WHERE a.member_id=$1 AND a.state='active' AND a.room_id = ANY($2)`,
        [secondSuccessorId, disclosedRooms],
      )
    ).rows[0]?.digest;
    expect(stored.target_assignment_digest).toBe(digestOfDisclosed);

    /* And the consequence: if the disclosure predates the batch, apply is refused rather
     * than revoking the room the Owner never saw named. */
    if (stored.impact.revokedAssignmentCount === 1) {
      await expect(
        databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
          secondSuccessorId,
          ownerId,
          stored.target_revision,
          freshAuthentication(),
          previewId,
          'TRANSFER OWNERSHIP',
          createOpaqueId(),
          createCorrelationId(),
        ]),
      ).rejects.toMatchObject({ code: '40001' });
      expect(await activeAssignments(secondSuccessorId)).toHaveLength(2);
      expect(
        (
          await migrationPool.query<{ global_role: string }>(
            'SELECT global_role FROM member WHERE id=$1',
            [ownerId],
          )
        ).rows[0]?.global_role,
      ).toBe('owner');
    }
    await migrationPool.query('DELETE FROM room_assignment WHERE member_id=$1', [
      secondSuccessorId,
    ]);
  });

  /*
   * The lock is the mechanism the test above depends on, so it is asserted directly in
   * the other direction too: a preview must WAIT for an assignment batch already in
   * flight for that member rather than reading around it.
   *
   * Without this, a future change that derived the preview from a single statement but
   * dropped the lock would still pass the interleaving test by luck of scheduling. Here
   * the batch holds the target's row lock first, so the preview provably blocks and then
   * discloses the committed result.
   */
  it('waits for an in-flight assignment batch rather than previewing around it', async () => {
    await migrationPool.query(
      "UPDATE member SET global_role='member',state='active' WHERE id=$1",
      [secondSuccessorId],
    );
    await migrationPool.query('DELETE FROM room_assignment WHERE member_id=$1', [
      secondSuccessorId,
    ]);

    const previewId = createOpaqueId();
    const mutationTx = await databasePool.connect();
    const previewTx = await databasePool.connect();
    try {
      await mutationTx.query('BEGIN');
      await mutationTx.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
        secondSuccessorId,
        JSON.stringify([
          { roomId: firstRoomId, roomRole: 'manager' },
          { roomId: secondRoomId, roomRole: 'contributor' },
        ]),
        JSON.stringify([]),
        ownerId,
        createOpaqueId(),
        createCorrelationId(),
      ]);

      const previewPid = await backendPid(previewTx);
      await previewTx.query('BEGIN');
      const preview = previewTx
        .query<{
          dry_run_ownership_transfer: { readonly revokedAssignmentCount: number };
        }>('SELECT dry_run_ownership_transfer($1,$2,$3)', [
          previewId,
          secondSuccessorId,
          ownerId,
        ])
        .then(
          (result) => result.rows[0]?.dry_run_ownership_transfer,
          (error: unknown) => error,
        );
      // Blocked on the batch's lock: it cannot describe a half-applied staffing change.
      await waitUntilBlocked(previewPid);
      await mutationTx.query('COMMIT');
      /* It describes the COMMITTED set, both rooms, rather than the empty set it would
       * have seen had it read past the lock. */
      expect(await preview).toMatchObject({ revokedAssignmentCount: 2 });
      await previewTx.query('COMMIT');
    } finally {
      mutationTx.release();
      previewTx.release();
    }
    await migrationPool.query('DELETE FROM room_assignment WHERE member_id=$1', [
      secondSuccessorId,
    ]);
  });

  /*
   * The apply must be bound to the exact impact the Owner approved.
   *
   * member.revision does NOT move when a room_assignment row changes, so the revision
   * check alone could not notice this: an assignment added or revoked between preview
   * and apply meant the transfer silently revoked a set the Owner never saw. The
   * preview records a digest of the successor's assignment set and transfer_ownership
   * re-checks it under the target's row lock.
   */
  it('refuses an apply whose successor assignments changed after the preview', async () => {
    await migrationPool.query(
      "UPDATE member SET global_role='member',state='active' WHERE id=$1",
      [secondSuccessorId],
    );
    await migrationPool.query('DELETE FROM room_assignment WHERE member_id=$1', [
      secondSuccessorId,
    ]);
    for (const [label, mutate] of [
      [
        'assignment added',
        async (): Promise<void> => {
          await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
            secondSuccessorId,
            JSON.stringify([{ roomId: thirdRoomId, roomRole: 'contributor' }]),
            JSON.stringify([]),
            ownerId,
            createOpaqueId(),
            createCorrelationId(),
          ]);
        },
      ],
      [
        'assignment revoked',
        async (): Promise<void> => {
          await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
            secondSuccessorId,
            JSON.stringify([]),
            JSON.stringify([thirdRoomId]),
            ownerId,
            createOpaqueId(),
            createCorrelationId(),
          ]);
        },
      ],
    ] as const) {
      const preview = await issuePreview(secondSuccessorId);
      await mutate();
      /* The revision is unchanged by an assignment mutation, so this apply passes
       * every check the previous implementation had. */
      expect(await currentRevision(secondSuccessorId)).toBe(preview.expectedRevision);
      await expect(
        databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
          secondSuccessorId,
          ownerId,
          preview.expectedRevision,
          freshAuthentication(),
          preview.previewId,
          preview.confirmation,
          createOpaqueId(),
          createCorrelationId(),
        ]),
        label,
      ).rejects.toMatchObject({ code: '40001' });
      /* Nothing moved: ownership is intact and the assignment set is whatever the
       * concurrent batch left, not something the refused transfer revoked. */
      expect(
        (
          await migrationPool.query<{ global_role: string }>(
            'SELECT global_role FROM member WHERE id=$1',
            [ownerId],
          )
        ).rows[0]?.global_role,
        label,
      ).toBe('owner');
    }
    /* A preview taken AFTER the change applies cleanly, so the refusal above is
     * staleness and not a permanent block. */
    const fresh = await issuePreview(secondSuccessorId);
    await databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
      secondSuccessorId,
      ownerId,
      fresh.expectedRevision,
      freshAuthentication(),
      fresh.previewId,
      fresh.confirmation,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    expect(
      (
        await migrationPool.query<{ global_role: string }>(
          'SELECT global_role FROM member WHERE id=$1',
          [secondSuccessorId],
        )
      ).rows[0]?.global_role,
    ).toBe('owner');
  });

  /* A refused stale-assignment apply must leave NOTHING behind -- not the demotion, not
   * the assignment revocation, and no audit row describing a transfer that did not
   * happen. The whole function is one transaction, so this is what proves the rollback
   * rather than assuming it. */
  it('rolls everything back when the assignment digest is stale', async () => {
    await migrationPool.query(
      "UPDATE member SET global_role='member',state='active' WHERE id=$1",
      [secondSuccessorId],
    );
    await migrationPool.query('DELETE FROM room_assignment WHERE member_id=$1', [
      secondSuccessorId,
    ]);
    await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
      secondSuccessorId,
      JSON.stringify([{ roomId: firstRoomId, roomRole: 'manager' }]),
      JSON.stringify([]),
      ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    const preview = await issuePreview(secondSuccessorId);
    await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
      secondSuccessorId,
      JSON.stringify([{ roomId: secondRoomId, roomRole: 'contributor' }]),
      JSON.stringify([]),
      ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    const correlationId = createCorrelationId();
    await expect(
      databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
        secondSuccessorId,
        ownerId,
        preview.expectedRevision,
        freshAuthentication(),
        preview.previewId,
        preview.confirmation,
        createOpaqueId(),
        correlationId,
      ]),
    ).rejects.toMatchObject({ code: '40001' });
    const roles = new Map(
      (
        await migrationPool.query<{ id: string; global_role: string }>(
          'SELECT id,global_role FROM member WHERE id = ANY($1)',
          [[ownerId, secondSuccessorId]],
        )
      ).rows.map(({ id, global_role }) => [id, global_role]),
    );
    expect(roles.get(ownerId)).toBe('owner');
    expect(roles.get(secondSuccessorId)).toBe('member');
    // Both assignments survive: the refused transfer revoked nothing.
    expect(await activeAssignments(secondSuccessorId)).toHaveLength(2);
    /* §15.1: no audit row for work that was rolled back. A spine entry describing a
     * transfer that never happened is worse than none. */
    expect(
      (
        await migrationPool.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM audit_event WHERE correlation_id=$1',
          [correlationId],
        )
      ).rows[0]?.count,
    ).toBe(0);
    /* The preview is not spent either, because consuming it and then refusing would
     * cost the Owner their evidence for a transfer that did not occur. */
    expect(
      (
        await migrationPool.query<{ consumed_at: Date | null }>(
          'SELECT consumed_at FROM ownership_transfer_preview WHERE id=$1',
          [preview.previewId],
        )
      ).rows[0]?.consumed_at,
    ).toBeNull();
    await migrationPool.query('DELETE FROM room_assignment WHERE member_id=$1', [
      secondSuccessorId,
    ]);
  });

  it('lets exactly one of two simultaneous transfers succeed', async () => {
    const first = await databasePool.connect();
    const second = await databasePool.connect();
    const successorRevision = await currentRevision(successorId);
    const secondRevision = await currentRevision(secondSuccessorId);
    try {
      const firstPreview = await issuePreview(successorId);
      const secondPreview = await issuePreview(secondSuccessorId);
      const secondPid = await backendPid(second);
      await first.query('BEGIN');
      await second.query('BEGIN');
      await first.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
        successorId,
        ownerId,
        successorRevision,
        freshAuthentication(),
        firstPreview.previewId,
        firstPreview.confirmation,
        createOpaqueId(),
        createCorrelationId(),
      ]);
      /* The second transfer names a different successor but the same outgoing
       * Owner, so it blocks on that locked row and must then find no Owner to
       * demote rather than producing a second owner. Each holds its own preview,
       * so the refusal is the ownership race and not preview reuse. */
      const blocked = second
        .query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
          secondSuccessorId,
          ownerId,
          secondRevision,
          freshAuthentication(),
          secondPreview.previewId,
          secondPreview.confirmation,
          createOpaqueId(),
          createCorrelationId(),
        ])
        .then(
          () => null,
          (error: unknown) => error,
        );
      await waitUntilBlocked(secondPid);
      await first.query('COMMIT');
      expect(await blocked).toMatchObject({ code: '42501' });
      await second.query('ROLLBACK');
    } finally {
      first.release();
      second.release();
    }
    expect(
      (
        await migrationPool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM member WHERE global_role='owner' AND state='active'",
        )
      ).rows[0]?.count,
    ).toBe(1);
  });
});

describe('apply_room_assignments', () => {
  beforeEach(async () => {
    await migrationPool.query('DELETE FROM room_assignment WHERE member_id=$1', [
      targetMemberId,
    ]);
    /* The transfer suite above reshuffles roles, and §4.2 makes only an active
     * plain Member assignable, so the target is restored explicitly. */
    await migrationPool.query(
      "UPDATE member SET global_role='member',state='active' WHERE id=$1",
      [targetMemberId],
    );
  });

  /*
   * §4.2: Owners and Admins already hold Room Manager authority in every room and
   * only Members receive explicit assignments. An assignment row for an
   * administrator would advertise a narrower role than the authority they actually
   * keep -- a 'contributor' badge beside standing Manager rights.
   */
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

  /*
   * Self-assignment would fire room_assignment_privilege_session_revoke against the
   * acting administrator, ending the very session that authorized the request while
   * the response reports only the assignment. Refused, and the actor's session is
   * asserted intact so the refusal is proven to have happened before any row change.
   */
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

  /*
   * The revoke loop used to UPDATE without checking the room, so an unknown room id
   * was indistinguishable from a valid unassigned one: changed=0, a success
   * response, and a success audit row naming work that could not have happened.
   */
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
    /* An unknown room in a batch that also carries valid work refuses the whole
     * batch, so nothing is half-applied. */
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

  /* A valid room the member simply does not hold is still a no-op success: that is
   * the case the unknown-room refusal above must remain distinguishable from. */
  it('accepts revoking a valid room the member does not hold', async () => {
    const applied = (
      await databasePool.query<{
        apply_room_assignments: { readonly changed: number };
      }>('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
        targetMemberId,
        JSON.stringify([]),
        JSON.stringify([secondRoomId]),
        ownerId,
        createOpaqueId(),
        createCorrelationId(),
      ])
    ).rows[0]?.apply_room_assignments;
    expect(applied?.changed).toBe(0);
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
    /* The caller receives the complete resulting set rather than a count it would
     * have to interpret: a surface that inferred the outcome from a number could
     * show access the server did not grant. Compared against the table read, which
     * orders by the same column under the same collation. */
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

  /*
   * One batch is one session revocation. Four separate calls would sign the
   * member out four times, which is what makes the batch shape load-bearing
   * rather than a convenience.
   */
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
    /* Two room rows changed, and one session existed, so exactly one session may
     * have moved to revoked. Four separate calls would have signed the member out
     * four times, which is what makes the batch shape load-bearing rather than a
     * convenience. */
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

  /*
   * Revocation never deletes, so the assignment lifecycle stays reconstructable.
   * Re-staffing previously deleted the revoked row to satisfy 001's all-states
   * UNIQUE (room_id, member_id), discarding its id and created_at;
   * one_active_room_assignment now constrains only the ACTIVE pair, so the terminal
   * row remains beside the new one. enforce_state_transition still permits only
   * active -> revoked, so nothing resurrects a revoked row by UPDATE either.
   */
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
    // Two rows: the new active assignment and the retained terminal one.
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ room_role: 'contributor', state: 'active' });
    expect(rows[1]).toMatchObject({ id: original, room_role: 'manager', state: 'revoked' });
    expect(rows[0]?.id).not.toBe(original);
    // The history accumulates across cycles rather than being overwritten.
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

  /* The uniqueness that matters is one ACTIVE assignment per room and member. It is
   * asserted directly so a future key-model change fails loudly here. */
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

  /* read_member_rooms explains WHY a room is reachable. It joined room_assignment
   * without filtering state, so a member whose assignment had been revoked was
   * still labelled with that role and access_source='assignment'. With terminal
   * rows now accumulating this would compound, so the corrected join is asserted. */
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
          'SELECT room_role,access_source FROM read_member_rooms($1) WHERE room_id=$2',
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
    // A plain member with no active assignment does not reach the room at all.
    expect(
      (
        await databasePool.query('SELECT room_id FROM read_member_rooms($1) WHERE room_id=$2', [
          targetMemberId,
          firstRoomId,
        ])
      ).rows,
    ).toEqual([]);
    /* An Owner reaches every room by global role. A retained revoked row must not
     * relabel that as an assignment, nor advertise the revoked role. */
    await migrationPool.query(
      "INSERT INTO room_assignment(id,room_id,member_id,room_role,state) VALUES($1,$2,$3,'contributor','revoked')",
      [createOpaqueId(), firstRoomId, ownerId],
    );
    try {
      expect(
        (
          await databasePool.query<{ room_role: string | null; access_source: string }>(
            'SELECT room_role,access_source FROM read_member_rooms($1) WHERE room_id=$2',
            [ownerId, firstRoomId],
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
    const repeated = (
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
    expect(repeated?.changed).toBe(0);
    expect(await activeAssignments(targetMemberId)).toEqual([
      { room_id: firstRoomId, room_role: 'contributor' },
    ]);
  });

  it('revoking a room the member does not hold changes nothing', async () => {
    const applied = (
      await databasePool.query<{
        apply_room_assignments: {
          readonly changed: number;
          readonly assignments: readonly unknown[];
        };
      }>('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
        targetMemberId,
        JSON.stringify([]),
        JSON.stringify([secondRoomId]),
        ownerId,
        createOpaqueId(),
        createCorrelationId(),
      ])
    ).rows[0]?.apply_room_assignments;
    expect(applied).toEqual({ memberId: targetMemberId, changed: 0, assignments: [] });
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

  /*
   * The batch is validated before anything is written, so a malformed entry
   * cannot leave a half-applied change or an audit row describing rolled-back
   * work. Each hostile shape is checked for that as well as for the refusal.
   */
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

  /*
   * The target member row is the serialization point, so two batches for one member
   * cannot interleave regardless of which rooms they name. Locking only the
   * individual room_assignment rows left batches for DIFFERENT rooms with no common
   * lock: both committed, and each returned a "complete resulting set" that omitted
   * the other's rows, so the surface could display access that was already stale.
   */
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
      /* The second batch waited, so its response describes the member AFTER the
       * first batch: two rooms, not one. A stale set here would be the defect. */
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
      /* Both name the same room, and the member lock serializes them, so the second
       * observes the first's committed row and changes the role rather than
       * inserting a duplicate. One active row either way. */
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

  /*
   * A concurrent disable used to pass the unlocked eligibility check and leave
   * assignments on a member who was no longer eligible for them. The member lock
   * makes the two mutually exclusive: whichever commits first, the other observes it.
   */
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

  /* The same lock also excludes a concurrent promotion, which would otherwise leave
   * an assignment row on an Admin who holds standing Manager authority (§4.2). */
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

/*
 * Assignments travel with the member subject, so these exercise what the member list
 * itself promises about them: every subject it returns carries its COMPLETE active
 * set, and the page is bounded by returning fewer SUBJECTS rather than by shortening
 * anyone's rooms.
 */
describe('read_members assignment completeness', () => {
  /** Members staffed across every bulk room by the bounding tests below. */
  const staffed = [targetMemberId, disposableMemberId, secondSuccessorId] as const;

  beforeEach(async () => {
    /* The transfer suite reshuffles global roles, and §4.2 makes only an active plain
     * Member assignable, so the targets are restored before staffing them. */
    await migrationPool.query(
      "UPDATE member SET global_role='member',state='active' WHERE id = ANY($1)",
      [[...staffed]],
    );
    await migrationPool.query('DELETE FROM room_assignment WHERE member_id = ANY($1)', [
      [...staffed],
    ]);
  });

  /** Total subjects the reader can see: members plus live pending invitations. */
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

  /** Staffs one member across every bulk room, in batches the apply bound permits. */
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
    /* A revoked assignment is not access, so it leaves the list rather than lingering
     * as a role the member no longer holds. */
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

  /* An invited person has no member row until acceptance, so there is no assignment
   * that could belong to them. The column is an empty array rather than null, so a
   * surface reads one shape for both kinds of subject. */
  it('gives a pending invitation an empty assignment array rather than null', async () => {
    const invitation = (await page(100)).find(
      ({ subject_kind }) => subject_kind === 'invitation',
    );
    expect(invitation).toBeDefined();
    expect(invitation?.assignments).toEqual([]);
  });

  /*
   * §23 requires a bound on every growing collection, and rooms have no installation
   * cap, so a page cannot carry "every assignment of up to 100 members".
   *
   * The bound is spent on SUBJECTS, not on any one member's rooms. Truncating the
   * rooms produced a response that could only say "something on this page is
   * incomplete": a surface could not tell WHICH member's list was short, and a short
   * room list reads as that member's whole access -- a false access claim. Dropping
   * trailing subjects instead leaves every returned subject complete and the
   * remainder reachable through the ordinary cursor.
   *
   * 3 x 200 = 600 active assignments, past the 500-row page budget, so the cut is
   * forced rather than incidental.
   */
  it('bounds a page by dropping trailing subjects, never by shortening one member', async () => {
    for (const memberId of staffed) await staffAcrossBulkRooms(memberId);
    const total = await subjectTotal();
    expect(total).toBeGreaterThan(staffed.length);
    /* The limit exceeds the whole collection, so ONLY the assignment budget can end a
     * page here. Anything shorter than `total` is the budget's doing. */
    expect(total).toBeLessThan(100);

    const walked: string[] = [];
    let cursor: { readonly createdAt: string; readonly subjectId: string } | undefined;
    let pages = 0;
    for (;;) {
      const rows = await page(100, cursor);
      pages += 1;
      // Never an empty page while subjects remain, so the walk always progresses.
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.reduce((sum, row) => sum + row.assignments.length, 0)).toBeLessThanOrEqual(
        500,
      );
      for (const row of rows) {
        walked.push(row.subject_id);
        /* Complete, always: each staffed member's list is the full 200 rooms wherever
         * on the walk they appear, never a prefix that fit the remaining budget. */
        if ((staffed as readonly string[]).includes(row.subject_id))
          expect(row.assignments, row.subject_id).toHaveLength(bulkRoomIds.length);
      }
      const last = rows.at(-1);
      if (last?.continues !== true) break;
      /* THE TRAP: this page is shorter than the requested limit and still continues.
       * A client that inferred "no more" from a short page would stop here and present
       * a partial member list as the whole organization, which is why the reader states
       * continuation rather than leaving it to be guessed from the row count. */
      expect(rows.length).toBeLessThan(100);
      cursor = { createdAt: last.cursor_created_at, subjectId: last.subject_id };
      expect(pages).toBeLessThan(20);
    }
    // More than one page despite a limit larger than the collection.
    expect(pages).toBeGreaterThan(1);
    expect(walked).toHaveLength(total);
    expect(new Set(walked).size).toBe(walked.length);
  });

  /*
   * The leading subject is always admitted, so a walk cannot stall on a member whose
   * own set fills the budget. apply_room_assignments caps one member at 500 active
   * assignments -- the same number as the page budget -- which is what makes that
   * promise bounded rather than an escape hatch.
   *
   * A limit of 1 is the sharpest form of the question: every page must hold exactly
   * that one subject, complete, including the heavily staffed ones.
   */
  it('always admits the leading subject so a one-subject walk cannot stall', async () => {
    for (const memberId of staffed) await staffAcrossBulkRooms(memberId);
    const total = await subjectTotal();
    const walked: string[] = [];
    let cursor: { readonly createdAt: string; readonly subjectId: string } | undefined;
    for (let step = 0; step < total + 5; step += 1) {
      const rows = await page(1, cursor);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (row === undefined) throw new Error('page unexpectedly empty');
      walked.push(row.subject_id);
      if ((staffed as readonly string[]).includes(row.subject_id))
        expect(row.assignments, row.subject_id).toHaveLength(bulkRoomIds.length);
      if (!row.continues) break;
      cursor = { createdAt: row.cursor_created_at, subjectId: row.subject_id };
    }
    expect(walked).toHaveLength(total);
    expect(new Set(walked).size).toBe(walked.length);
  });
});

describe('organization administration function boundaries', () => {
  it('registers migration 017 exactly once in the generated sequence', () => {
    expect(
      generatedMigrations.filter(({ id }) => id === '017_organization_administration'),
    ).toHaveLength(1);
    expect(new Set(generatedMigrations.map(({ id }) => id)).size).toBe(
      generatedMigrations.length,
    );
  });

  /*
   * An audit row whose event type is absent from SECURITY_EVENT_TYPES is
   * unreadable through the typed audit layer, so the catalogue and the SQL that
   * writes it must not drift.
   */
  it('emits only event types the security catalogue names', async () => {
    const sources = await migrationPool.query<{ source: string }>(
      `SELECT prosrc AS source FROM pg_proc
       WHERE oid = ANY (ARRAY[
         'invite_member(text,text,text,text,text,text,text,text)',
         'revoke_member_invitation(text,text,text,text)',
         'set_member_global_role(text,text,text,integer,text,text)',
         'set_member_state(text,text,text,integer,text,text)',
         'transfer_ownership(text,text,integer,timestamptz,text,text,text,text)',
         'apply_room_assignments(text,jsonb,jsonb,text,text,text)',
         'supersede_room_assignments_for_role(text,text,text,text)'
       ]::regprocedure[])`,
    );
    expect(sources.rows).toHaveLength(7);
    /* Each audit insert is isolated to its own statement, then the first dotted
     * literal inside it is taken. Scanning positionally is unreliable because the
     * audit id may be an expression containing commas, and scanning the whole body
     * would pick up the job type in the queue insert. */
    const emitted = sources.rows.flatMap(({ source }) =>
      source
        .split(/INSERT INTO audit_event/giu)
        .slice(1)
        .map((statement) => {
          const type = /'([a-z][a-z0-9_]*\.[a-z0-9_.]+)'/u.exec(
            statement.slice(0, statement.indexOf(';')),
          )?.[1];
          if (type === undefined) throw new Error('audit insert without an event type');
          return type;
        }),
    );
    expect(emitted.toSorted()).toEqual([
      'invitation.created',
      'invitation.expired',
      'invitation.revoked',
      'member.role',
      'member.state',
      'ownership.transferred',
      /* Twice: apply_room_assignments writes the batch event, and
       * supersede_room_assignments_for_role writes the one that records a role change
       * clearing a member's explicit assignments. */
      'room.assignment',
      'room.assignment',
    ]);
    for (const type of emitted)
      expect(SECURITY_EVENT_TYPES, `uncatalogued event type ${type}`).toContain(type);
  });

  it('owns every function with the migration role and grants only its intended caller', async () => {
    const functions = [
      {
        signature: 'assert_organization_administrator(text)',
        runtime: false,
        worker: false,
      },
      {
        signature: 'invite_member(text,text,text,text,text,text,text,text)',
        runtime: true,
        worker: false,
      },
      {
        signature: 'revoke_member_invitation(text,text,text,text)',
        runtime: true,
        worker: false,
      },
      {
        signature: 'read_members(text,timestamptz,text,integer)',
        runtime: true,
        worker: false,
      },
      {
        signature: 'cancel_member_invitation_mail(text)',
        runtime: false,
        worker: false,
      },
      {
        signature: 'read_member_invitation_mail(text,text,text,text)',
        runtime: false,
        worker: true,
      },
      {
        signature: 'set_member_global_role(text,text,text,integer,text,text)',
        runtime: true,
        worker: false,
      },
      {
        signature: 'set_member_state(text,text,text,integer,text,text)',
        runtime: true,
        worker: false,
      },
      {
        signature: 'dry_run_ownership_transfer(text,text,text)',
        runtime: true,
        worker: false,
      },
      {
        signature: 'transfer_ownership(text,text,integer,timestamptz,text,text,text,text)',
        runtime: true,
        worker: false,
      },
      {
        signature: 'apply_room_assignments(text,jsonb,jsonb,text,text,text)',
        runtime: true,
        worker: false,
      },
      {
        signature: 'member_assignment_impact(text)',
        runtime: false,
        worker: false,
      },
      {
        signature: 'supersede_room_assignments_for_role(text,text,text,text)',
        runtime: false,
        worker: false,
      },
    ] as const;
    for (const fn of functions) {
      const owner = await migrationPool.query<{ owner: string }>(
        'SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid=$1::regprocedure',
        [fn.signature],
      );
      expect(owner.rows[0]?.owner, fn.signature).toBe('duefold_migration');
      for (const [role, expected] of [
        ['duefold_runtime', fn.runtime],
        ['duefold_worker', fn.worker],
        ['duefold_authenticator', false],
      ] as const) {
        const privilege = await migrationPool.query<{ allowed: boolean }>(
          'SELECT has_function_privilege($1,$2,$3) AS allowed',
          [role, fn.signature, 'EXECUTE'],
        );
        expect(privilege.rows[0]?.allowed, `${role} EXECUTE ${fn.signature}`).toBe(expected);
      }
      const publicExecute = await migrationPool.query<{ allowed: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) acl
           WHERE p.oid=$1::regprocedure AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
         ) AS allowed`,
        [fn.signature],
      );
      expect(publicExecute.rows[0]?.allowed, `PUBLIC EXECUTE ${fn.signature}`).toBe(false);
    }
  });

  /*
   * The FINAL INSTALLED table ACLs, after every migration in the generated sequence
   * has been applied. Function EXECUTE grants alone proved nothing here: 001 granted
   * duefold_runtime full DML on room_assignment and duefold_authenticator full DML on
   * room_assignment, invitation, and member, so every audited boundary above could be
   * sidestepped with plain SQL -- a room privilege granted with no administrator check
   * and no audit row, or an invitation's intended_global_role rewritten from 'member'
   * to 'admin' before acceptance. Both defeat invariant 14.
   *
   * PostgreSQL grants are additive and 007's narrow re-grant never removed 001's
   * broad one, so this asserts the end state rather than any single migration's text.
   */
  it('leaves no application role able to mutate identity or room privilege directly', async () => {
    const matrix = [
      /* The web credential resolves room roles on every request, so it reads. It
       * writes nothing: apply_room_assignments is the only path. */
      { table: 'room_assignment', role: 'duefold_runtime', allowed: ['SELECT'] },
      { table: 'room_assignment', role: 'duefold_authenticator', allowed: ['SELECT'] },
      { table: 'room_assignment', role: 'duefold_worker', allowed: [] },
      /* Acceptance reads a pending invitation and writes only its state. It can
       * neither author an invitation nor choose the role one carries. */
      { table: 'invitation', role: 'duefold_authenticator', allowed: ['SELECT'] },
      { table: 'invitation', role: 'duefold_runtime', allowed: [] },
      { table: 'invitation', role: 'duefold_worker', allowed: [] },
      /* Role and state changes are confined to the audited functions. */
      { table: 'member', role: 'duefold_runtime', allowed: ['SELECT'] },
      { table: 'member', role: 'duefold_worker', allowed: [] },
      { table: 'ownership_transfer_preview', role: 'duefold_runtime', allowed: [] },
      { table: 'ownership_transfer_preview', role: 'duefold_authenticator', allowed: [] },
      { table: 'ownership_transfer_preview', role: 'duefold_worker', allowed: [] },
    ] as const;
    for (const { table, role, allowed } of matrix)
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] as const) {
        const held = (
          await migrationPool.query<{ held: boolean }>(
            'SELECT has_table_privilege($1,$2,$3) AS held',
            [role, table, privilege],
          )
        ).rows[0]?.held;
        expect(held, `${role} ${privilege} ON ${table}`).toBe(
          (allowed as readonly string[]).includes(privilege),
        );
      }

    /* Column-level authority, because a table-level UPDATE grant is not the only
     * way to reach one column. intended_global_role is the escalation-relevant one:
     * writing it before acceptance turns an invited Member into an Admin. */
    for (const [role, column, expected] of [
      ['duefold_authenticator', 'state', true],
      ['duefold_authenticator', 'intended_global_role', false],
      ['duefold_authenticator', 'email_key', false],
      ['duefold_authenticator', 'kind', false],
      ['duefold_runtime', 'state', false],
      ['duefold_runtime', 'intended_global_role', false],
    ] as const)
      expect(
        (
          await migrationPool.query<{ held: boolean }>(
            "SELECT has_column_privilege($1,'invitation',$2,'UPDATE') AS held",
            [role, column],
          )
        ).rows[0]?.held,
        `${role} UPDATE(invitation.${column})`,
      ).toBe(expected);

    /* member keeps authenticator DML: first-owner bootstrap, OIDC acceptance, and
     * guarded CLI recovery all write member rows on that credential, each with its
     * audit row in the same transaction. Asserted so the narrowing above is not
     * mistaken for a removal that would break sign-in. */
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE'] as const)
      expect(
        (
          await migrationPool.query<{ held: boolean }>(
            'SELECT has_table_privilege($1,$2,$3) AS held',
            ['duefold_authenticator', 'member', privilege],
          )
        ).rows[0]?.held,
        `duefold_authenticator ${privilege} ON member`,
      ).toBe(true);
  });

  /*
   * The ACL assertions above describe what PostgreSQL reports. These attempt the
   * actual bypasses, so the finding is closed by behaviour and not only by catalogue
   * inspection.
   */
  it('refuses the direct bypasses those grants used to permit', async () => {
    const assignmentId = createOpaqueId();
    for (const [statement, parameters] of [
      [
        "INSERT INTO room_assignment(id,room_id,member_id,room_role) VALUES($1,$2,$3,'manager')",
        [assignmentId, firstRoomId, targetMemberId],
      ],
      ["UPDATE room_assignment SET room_role='manager' WHERE member_id=$1", [targetMemberId]],
      ['DELETE FROM room_assignment WHERE member_id=$1', [targetMemberId]],
      ["UPDATE member SET global_role='owner' WHERE id=$1", [plainMemberId]],
      ["UPDATE member SET state='disabled' WHERE id=$1", [targetMemberId]],
    ] as const)
      await expect(databasePool.query(statement, [...parameters])).rejects.toMatchObject({
        code: '42501',
      });

    /* The authenticator credential holds the invitation privileges acceptance needs.
     * It must still not be able to escalate the role an invitation will grant. */
    const invitationId = createOpaqueId();
    await databasePool.query('SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)', [
      invitationId,
      'acl.escalation@example.test',
      'ACL.Escalation@example.test',
      'member',
      ownerId,
      createOpaqueId(),
      createOpaqueId(),
      createCorrelationId(),
    ]);
    await expect(
      authPool.query("UPDATE invitation SET intended_global_role='admin' WHERE id=$1", [
        invitationId,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      authPool.query(
        `INSERT INTO invitation(id,kind,email_key,email_display,state,expires_at,intended_global_role)
         VALUES($1,'member','acl.forged@example.test','acl.forged@example.test','pending',
                statement_timestamp()+interval '7 days','admin')`,
        [createOpaqueId()],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    expect(
      (
        await migrationPool.query<{ intended_global_role: string }>(
          'SELECT intended_global_role FROM invitation WHERE id=$1',
          [invitationId],
        )
      ).rows[0]?.intended_global_role,
    ).toBe('member');
    /* The state update acceptance genuinely performs still works, so the narrowing
     * did not break invitation acceptance. */
    await expect(
      authPool.query("UPDATE invitation SET state='revoked' WHERE id=$1", [invitationId]),
    ).resolves.toMatchObject({ rowCount: 1 });
  });
});
