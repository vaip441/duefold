import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import {
  closeAdministrationPools,
  databasePool,
  migrationPool,
  seedAdministrationFixture,
  type AdministrationFixture,
} from './support/administration-fixture.ts';

let fixture: AdministrationFixture;
let ownerId: string;
let adminId: string;
let disabledAdminId: string;
let plainMemberId: string;

beforeAll(async () => {
  fixture = await seedAdministrationFixture();
  ({ ownerId, adminId, disabledAdminId, plainMemberId } = fixture);
});

afterAll(closeAdministrationPools);

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
    const events = (
      await migrationPool.query<{
        event_type: string;
        actor_kind: string;
        actor_id: string | null;
        resource_id: string;
        reason_code: string;
        detail: Readonly<Record<string, unknown>>;
      }>(
        `SELECT event_type,actor_kind,actor_id,resource_id,reason_code,detail FROM audit_event
          WHERE correlation_id=$1 ORDER BY event_type`,
        [correlationId],
      )
    ).rows;
    expect(
      events.map(({ event_type, actor_kind, actor_id, resource_id, reason_code }) => ({
        event_type,
        actor_kind,
        actor_id,
        resource_id,
        reason_code,
      })),
    ).toEqual([
      {
        event_type: 'invitation.created',
        actor_kind: 'member',
        actor_id: ownerId,
        resource_id: replacementId,
        reason_code: 'MEMBER_INVITED',
      },
      {
        event_type: 'invitation.expired',
        actor_kind: 'system',
        actor_id: null,
        resource_id: lapsedId,
        reason_code: 'MEMBER_INVITATION_EXPIRED',
      },
    ]);
    expect(events[0]?.detail['intendedRole']).toBe('admin');
    expect(typeof events[0]?.detail['expiresAt']).toBe('string');
    expect(events[1]?.detail['supersededBy']).toBe(replacementId);
    expect(events[1]?.detail['noticedBy']).toBe(ownerId);
    expect(typeof events[1]?.detail['occurredBefore']).toBe('string');
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
