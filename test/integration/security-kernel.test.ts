import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { generatedMigrations } from '../../.duefold/generated/migrations.ts';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import { FixedClock } from '@duefold/shared/clock';
import { migrate } from '../../modules/core-security/src/db/migrate.ts';
import { recoverOwner } from '../../modules/core-security/src/recovery.ts';
import {
  createOtpChallenge,
  consumeOtp,
  OTP_DELIVERY_JOB,
} from '../../modules/core-security/src/auth/otp.ts';
import { createHandler as createOtpDeliveryHandler } from '../../modules/core-security/src/jobs/otp-delivery.ts';
import {
  beginOidc,
  claimFirstOwner,
  consumeOidcTransaction,
  persistOidcTransaction,
  resolveOidcMember,
} from '../../modules/core-security/src/auth/oidc.ts';
import {
  issueSession,
  revokePrincipalSessions,
  revokeSessionFamily,
  rotateSession,
} from '../../modules/core-security/src/sessions.ts';
import { createSessionAuthenticator } from '../../apps/web/src/authenticate.ts';
import type { FastifyRequest } from 'fastify';
import { JobRunner } from '../../apps/worker/src/runner.ts';

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
const runtimePool = new Pool({
  connectionString:
    process.env['DUEFOLD_TEST_DATABASE_URL'] ??
    'postgresql://duefold_runtime:duefold_local_runtime@127.0.0.1:5432/duefold_test',
  max: 8,
});
const authPool = new Pool({
  connectionString:
    process.env['DUEFOLD_TEST_AUTH_DATABASE_URL'] ??
    'postgresql://duefold_authenticator:duefold_local_authenticator@127.0.0.1:5432/duefold_test',
  max: 8,
});
const workerPool = new Pool({
  connectionString:
    process.env['DUEFOLD_TEST_WORKER_DATABASE_URL'] ??
    'postgresql://duefold_worker:duefold_local_worker@127.0.0.1:5432/duefold_test',
  max: 8,
});
const ownerId = createOpaqueId();
const viewerId = createOpaqueId();
const sessionPolicy = { idleMinutes: 30, absoluteHours: 12 };

async function migrateFresh(): Promise<void> {
  await bootstrapPool.query(
    'DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE, CREATE ON SCHEMA public TO duefold_migration;',
  );
  await bootstrapPool.query('ALTER SCHEMA public OWNER TO duefold_migration');
  await migrate(migrationPool, generatedMigrations);
}
async function reset(): Promise<void> {
  await migrateFresh();
  const client = await migrationPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO member (id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state) VALUES ($1,'owner@example.com','Owner@example.com','https://issuer.example','owner','owner','active')",
      [ownerId],
    );
    await client.query("INSERT INTO organization (id,name) VALUES ($1,'Duefold Test')", [
      createOpaqueId(),
    ]);
    await client.query(
      "INSERT INTO viewer (id,email_key,email_display,session_family_id) VALUES ($1,'viewer@example.com','Viewer@example.com',$2)",
      [viewerId, createOpaqueId()],
    );
    await migrationPool.query(
      "INSERT INTO invitation (id,kind,email_key,email_display,state,expires_at) VALUES ($1,'viewer','viewer@example.com','Viewer@example.com','pending',transaction_timestamp() + interval '7 days')",
      [createOpaqueId()],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(reset);
afterAll(async () => {
  await authPool.end();
  await runtimePool.end();
  await workerPool.end();
  await migrationPool.end();
  await bootstrapPool.end();
});

function sessionRequest(secret: string): FastifyRequest {
  return { cookies: { '__Host-duefold_session': secret } } as unknown as FastifyRequest;
}
async function deliverChallenge(
  challengeId: string,
  clock: FixedClock,
): Promise<string | null> {
  const delivered: { code?: string } = {};
  const handler = createOtpDeliveryHandler({
    pool: workerPool,
    otpDigestKey: Buffer.alloc(32, 1).toString('base64url'),
    clock,
    mailer: {
      deliver: (message) => {
        if (message.challengeId === challengeId) delivered.code = message.code;
        return Promise.resolve();
      },
      close: () => undefined,
    },
  });
  const runner = new JobRunner(workerPool, new Map([[OTP_DELIVERY_JOB, handler]]));
  for (let index = 0; index < 20; index += 1) {
    await runner.runOne();
    if (delivered.code !== undefined) break;
  }
  return delivered.code ?? null;
}
function sqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

describe('security migration and role boundaries', () => {
  it('is repeatable, checksum immutable, and ledger must be an exact registry prefix', async () => {
    await migrate(migrationPool, generatedMigrations);
    const source = generatedMigrations[0];
    expect(source).toBeDefined();
    const remaining = generatedMigrations.slice(1);
    const directory = await mkdtemp(join(tmpdir(), 'duefold-migration-'));
    const changed = join(directory, 'changed.sql');
    await writeFile(changed, `${await readFile(source!.path, 'utf8')}\n-- changed\n`);
    await expect(
      migrate(migrationPool, [{ ...source!, path: changed }, ...remaining]),
    ).rejects.toThrow('checksum mismatch');
    await expect(migrate(migrationPool, [])).rejects.toThrow('registry prefix');
    const backfill = join(directory, 'backfill.sql');
    await writeFile(backfill, 'SELECT 1;');
    await expect(
      migrate(migrationPool, [
        { id: '000_backfill', module: 'core-security', path: backfill },
        source!,
        ...remaining,
      ]),
    ).rejects.toThrow('registry prefix');
  });

  it('lets migration login ALTER existing objects while runtime login cannot', async () => {
    await migrationPool.query('ALTER TABLE mutation_key ADD COLUMN migration_probe boolean');
    await migrationPool.query(
      "INSERT INTO audit_event (id,event_type,actor_kind,result,reason_code,correlation_id) VALUES ($1,'auth.oidc','system','success','MIGRATION_PROBE',$2)",
      [createOpaqueId(), createCorrelationId()],
    );
    await migrationPool.query('ALTER TABLE mutation_key DROP COLUMN migration_probe');
    await expect(
      runtimePool.query('ALTER TABLE mutation_key ADD COLUMN runtime_probe boolean'),
    ).rejects.toThrow();
  });

  it('rejects organization deletion and last-Owner deletion/demotion at commit', async () => {
    await expect(runtimePool.query('DELETE FROM organization')).rejects.toMatchObject({
      code: '42501',
    });
    const deletion = await migrationPool.connect();
    try {
      await deletion.query('BEGIN');
      await deletion.query('DELETE FROM member WHERE id = $1', [ownerId]);
      try {
        await deletion.query('COMMIT');
        throw new Error('last Owner deletion unexpectedly committed');
      } catch (error) {
        expect(sqlState(error)).toBe('23514');
      }
      await deletion.query('ROLLBACK');
    } finally {
      deletion.release();
    }
    const demotion = await migrationPool.connect();
    try {
      await demotion.query('BEGIN');
      await demotion.query("UPDATE member SET global_role = 'admin' WHERE id = $1", [ownerId]);
      try {
        await demotion.query('COMMIT');
        throw new Error('last Owner demotion unexpectedly committed');
      } catch (error) {
        expect(sqlState(error)).toBe('23514');
      }
      await demotion.query('ROLLBACK');
    } finally {
      demotion.release();
    }
    expect(
      (await runtimePool.query<{ n: number }>('SELECT count(*)::int AS n FROM organization'))
        .rows[0]?.n,
    ).toBe(1);
    expect(
      (
        await runtimePool.query<{ global_role: string }>(
          'SELECT global_role FROM member WHERE id = $1',
          [ownerId],
        )
      ).rows[0]?.global_role,
    ).toBe('owner');
  });

  it('persists OIDC state and consumes it strictly once', async () => {
    const configuration = new (await import('openid-client')).Configuration(
      {
        issuer: 'https://issuer.example',
        authorization_endpoint: 'https://issuer.example/auth',
      },
      'client',
    );
    const transaction = await beginOidc(configuration, 'https://duefold.example/callback');
    await persistOidcTransaction(authPool, transaction);
    expect(await consumeOidcTransaction(authPool, transaction.state)).toMatchObject({
      state: transaction.state,
      nonce: transaction.nonce,
      codeVerifier: transaction.codeVerifier,
    });
    await expect(consumeOidcTransaction(authPool, transaction.state)).rejects.toThrow(
      'OIDC_TRANSACTION_INVALID',
    );
  });

  it('prevents runtime mutation of audit rows through a real role login', async () => {
    const auditId = createOpaqueId();
    await runtimePool.query(
      "INSERT INTO audit_event (id,event_type,actor_kind,result,reason_code,correlation_id) VALUES ($1,'auth.oidc','system','success','TEST',$2)",
      [auditId, createCorrelationId()],
    );
    await expect(
      runtimePool.query("UPDATE audit_event SET reason_code = 'ALTERED' WHERE id = $1", [
        auditId,
      ]),
    ).rejects.toThrow();
    await expect(
      runtimePool.query('DELETE FROM audit_event WHERE id = $1', [auditId]),
    ).rejects.toThrow();
  });

  it('enforces canonical email keys and every mutable state transition', async () => {
    await expect(
      runtimePool.query(
        "INSERT INTO invitation (id,kind,email_key,email_display,expires_at) VALUES ($1,'viewer','Mixed@Example.com','Mixed@Example.com',transaction_timestamp() + interval '1 day')",
        [createOpaqueId()],
      ),
    ).rejects.toThrow();
    const assignmentId = createOpaqueId();
    const assignmentRoomId = createOpaqueId();
    await runtimePool.query('SELECT create_room($1,$2,$3,$4,$5,$6)', [
      assignmentRoomId,
      'Assignment room',
      '',
      ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    /* The state machine is exercised on the migration credential, because migration
     * 017 revoked direct room_assignment DML from every application role. The
     * assertion is the same: enforce_state_transition permits active -> revoked and
     * never the reverse, so a revoked privilege cannot be resurrected by UPDATE even
     * by a credential with schema authority. */
    await migrationPool.query(
      "INSERT INTO room_assignment (id,room_id,member_id,room_role) VALUES ($1,$2,$3,'manager')",
      [assignmentId, assignmentRoomId, ownerId],
    );
    await migrationPool.query("UPDATE room_assignment SET state = 'revoked' WHERE id = $1", [
      assignmentId,
    ]);
    await expect(
      migrationPool.query("UPDATE room_assignment SET state = 'active' WHERE id = $1", [
        assignmentId,
      ]),
    ).rejects.toThrow();
    /* And the runtime credential cannot write the table at all, which is what makes
     * apply_room_assignments the only path to a room privilege. */
    await expect(
      runtimePool.query("UPDATE room_assignment SET state = 'active' WHERE id = $1", [
        assignmentId,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('OIDC member invitation acceptance', () => {
  it('accepts an Admin invitation with its intended role and fully identified audit evidence', async () => {
    const invitationId = createOpaqueId();
    await runtimePool.query('SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)', [
      invitationId,
      'promoted@example.test',
      'Promoted@example.test',
      'admin',
      ownerId,
      createOpaqueId(),
      createOpaqueId(),
      createCorrelationId(),
    ]);

    /* The callback's own correlation id must reach the audit rows rather than a
     * freshly invented one, so a sign-in is traceable end to end. */
    const correlationId = createCorrelationId();
    const { memberId } = await resolveOidcMember(
      authPool,
      {
        issuer: 'https://idp.example.test',
        subject: 'promoted-subject',
        emailKey: 'promoted@example.test',
        emailDisplay: 'Promoted@example.test',
        authenticatedAt: new Date(),
        authenticationTimeAsserted: true,
      },
      correlationId,
    );

    expect(
      (
        await migrationPool.query<{ global_role: string }>(
          'SELECT global_role FROM member WHERE id=$1',
          [memberId],
        )
      ).rows[0]?.global_role,
    ).toBe('admin');
    /* Both the authorizing invitation and the created member must be
     * independently identifiable, and both must carry the request correlation. */
    expect(
      (
        await migrationPool.query<{
          event_type: string;
          actor_id: string;
          subject_id: string;
          resource_type: string;
          resource_id: string;
          reason_code: string;
          correlation_id: string;
          detail: Record<string, unknown>;
        }>(
          `SELECT event_type,actor_id,subject_id,resource_type,resource_id,reason_code,
                  correlation_id,detail
             FROM audit_event
            WHERE correlation_id=$1 AND event_type IN ('invitation.accepted','member.created')
            ORDER BY event_type`,
          [correlationId],
        )
      ).rows,
    ).toEqual([
      {
        event_type: 'invitation.accepted',
        actor_id: memberId,
        subject_id: memberId,
        resource_type: 'invitation',
        resource_id: invitationId,
        reason_code: 'MEMBER_INVITATION_ACCEPTED',
        correlation_id: correlationId,
        detail: { intendedRole: 'admin' },
      },
      {
        event_type: 'member.created',
        actor_id: memberId,
        subject_id: memberId,
        resource_type: 'member',
        resource_id: memberId,
        reason_code: 'MEMBER_INVITATION_ACCEPTED',
        correlation_id: correlationId,
        detail: { invitationId, globalRole: 'admin' },
      },
    ]);
    expect(
      (
        await migrationPool.query<{ state: string }>(
          'SELECT state FROM invitation WHERE id=$1',
          [invitationId],
        )
      ).rows[0]?.state,
    ).toBe('accepted');
  });

  it('rolls member creation and invitation acceptance back when audit persistence fails', async () => {
    const invitationId = createOpaqueId();
    await runtimePool.query('SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)', [
      invitationId,
      'acceptance-rollback@example.test',
      'acceptance-rollback@example.test',
      'member',
      ownerId,
      createOpaqueId(),
      createOpaqueId(),
      createCorrelationId(),
    ]);
    await migrationPool.query(`CREATE FUNCTION fail_member_creation_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.event_type='member.created' THEN RAISE EXCEPTION 'injected member audit failure'; END IF;
        RETURN NEW;
      END $$`);
    await migrationPool.query(
      'CREATE TRIGGER fail_member_creation_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION fail_member_creation_audit()',
    );
    try {
      await expect(
        resolveOidcMember(
          authPool,
          {
            issuer: 'https://idp.example.test',
            subject: 'acceptance-rollback-subject',
            emailKey: 'acceptance-rollback@example.test',
            emailDisplay: 'acceptance-rollback@example.test',
            authenticatedAt: new Date(),
            authenticationTimeAsserted: true,
          },
          createCorrelationId(),
        ),
      ).rejects.toThrow('injected member audit failure');
      expect(
        (
          await migrationPool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM member WHERE email_key='acceptance-rollback@example.test'",
          )
        ).rows[0]?.count,
      ).toBe(0);
      expect(
        (
          await migrationPool.query<{ state: string }>(
            'SELECT state FROM invitation WHERE id=$1',
            [invitationId],
          )
        ).rows[0]?.state,
      ).toBe('pending');
      /* The acceptance event must not survive the failure of the creation event;
       * either the whole provisioning commits or none of its evidence does. */
      expect(
        (
          await migrationPool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM audit_event WHERE resource_id=$1 AND event_type='invitation.accepted'",
            [invitationId],
          )
        ).rows[0]?.count,
      ).toBe(0);
    } finally {
      await migrationPool.query('DROP TRIGGER fail_member_creation_audit ON audit_event');
      await migrationPool.query('DROP FUNCTION fail_member_creation_audit()');
    }
  });

  /*
   * Two browsers completing sign-in for one invitation must not both provision a
   * member. The row lock decides one winner; the loser is refused with the same
   * closed-set reason an uninvited identity receives.
   */
  it('admits exactly one member when two sign-ins race for one invitation', async () => {
    await runtimePool.query('SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)', [
      createOpaqueId(),
      'raced@example.test',
      'Raced@example.test',
      'member',
      ownerId,
      createOpaqueId(),
      createOpaqueId(),
      createCorrelationId(),
    ]);
    const attempt = (subject: string): Promise<{ readonly memberId: string }> =>
      resolveOidcMember(
        authPool,
        {
          issuer: 'https://idp.example.test',
          subject,
          emailKey: 'raced@example.test',
          emailDisplay: 'Raced@example.test',
          authenticatedAt: new Date(),
          authenticationTimeAsserted: true,
        },
        createCorrelationId(),
      );
    const outcomes = await Promise.allSettled([attempt('raced-a'), attempt('raced-b')]);
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(
      outcomes.flatMap((outcome) =>
        outcome.status === 'rejected' ? [(outcome.reason as Error).message] : [],
      ),
    ).toEqual(['MEMBER_INVITATION_REQUIRED']);
    expect(
      (
        await migrationPool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM member WHERE email_key='raced@example.test'",
        )
      ).rows[0]?.count,
    ).toBe(1);
    expect(
      (
        await migrationPool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM audit_event
            WHERE event_type='invitation.accepted'
              AND resource_id IN (SELECT id FROM invitation WHERE email_key='raced@example.test')`,
        )
      ).rows[0]?.count,
    ).toBe(1);
  });
});

describe('OTP invitation binding and concurrency', () => {
  const clock = new FixedClock(new Date());
  const base = {
    pool: authPool,
    normalizedIp: '192.0.2.1',
    digestKey: Buffer.alloc(32, 1).toString('base64url'),
    networkKey: Buffer.alloc(32, 2).toString('base64url'),
    client: { browser: 'firefox' as const, os: 'linux' as const, device: 'desktop' as const },
    clock,
  };

  it('binds an eligible delivery job to the exact viewer and gives unknown addresses equivalent queued work', async () => {
    const eligible = await createOtpChallenge({ ...base, email: 'VIEWER@example.com' });
    const eligibleCode = await deliverChallenge(eligible.id, clock);
    expect(eligibleCode).toMatch(/^\d{8}$/u);
    if (eligibleCode === null) throw new Error('eligible code missing');
    expect(
      await consumeOtp({
        pool: authPool,
        challengeId: eligible.id,
        code: eligibleCode,
        digestKey: base.digestKey,
        clock,
      }),
    ).toMatchObject({ kind: 'viewer', id: viewerId });
    const unknown = await createOtpChallenge({ ...base, email: 'unknown@example.com' });
    const unknownJob = await runtimePool.query<{
      job_type: string;
      payload: { challengeId: string };
    }>("SELECT job_type,payload FROM job_queue WHERE payload->>'challengeId' = $1", [
      unknown.id,
    ]);
    expect(unknownJob.rows[0]).toMatchObject({
      job_type: OTP_DELIVERY_JOB,
      payload: { challengeId: unknown.id },
    });
    expect(await deliverChallenge(unknown.id, clock)).toBeNull();
    expect(
      await authPool.query('SELECT digest,expires_at,state FROM otp_challenge WHERE id = $1', [
        unknown.id,
      ]),
    ).toMatchObject({
      rows: [{ digest: null, expires_at: null, state: 'invalidated' }],
    });
  });

  it('prevents a reclaimed stale OTP worker from overwriting the delivered digest', async () => {
    const challenge = await createOtpChallenge({
      ...base,
      email: 'viewer@example.com',
      normalizedIp: '192.0.2.21',
    });
    const queued = await runtimePool.query<{
      id: string;
      job_type: string;
      payload: Readonly<Record<string, unknown>>;
      attempts: number;
      max_attempts: number;
    }>(
      `SELECT id,job_type,payload,attempts,max_attempts FROM job_queue
       WHERE payload->>'challengeId' = $1`,
      [challenge.id],
    );
    const selected = queued.rows[0];
    if (selected === undefined) throw new Error('OTP job missing');
    const leaseOwner = createOpaqueId();
    const staleToken = createOpaqueId();
    await workerPool.query(
      `UPDATE job_queue SET state = 'running',attempts = 1,lease_owner = $2,lease_token = $3,
         lease_expires_at = transaction_timestamp() - interval '1 second' WHERE id = $1`,
      [selected.id, leaseOwner, staleToken],
    );
    const currentToken = createOpaqueId();
    await workerPool.query(
      `UPDATE job_queue SET attempts = 2,lease_owner = $2,lease_token = $3,
         lease_expires_at = transaction_timestamp() + interval '1 minute' WHERE id = $1`,
      [selected.id, leaseOwner, currentToken],
    );
    const delivered: string[] = [];
    let signalCurrentDelivery = (): void => undefined;
    const currentDeliveryStarted = new Promise<void>((resolve) => {
      signalCurrentDelivery = resolve;
    });
    let releaseCurrentDelivery = (): void => undefined;
    const handler = createOtpDeliveryHandler({
      pool: workerPool,
      otpDigestKey: base.digestKey,
      clock,
      mailer: {
        deliver: ({ code }) => {
          delivered.push(code);
          if (delivered.length !== 1) return Promise.resolve();
          signalCurrentDelivery();
          return new Promise<void>((resolve) => {
            releaseCurrentDelivery = resolve;
          });
        },
        close: () => undefined,
      },
    });
    const controller = new AbortController();
    const assertLease = async (leaseToken: string): Promise<void> => {
      const current = await workerPool.query(
        `SELECT 1 FROM job_queue WHERE id = $1 AND state = 'running'
           AND lease_owner = $2 AND lease_token = $3
           AND lease_expires_at > transaction_timestamp()`,
        [selected.id, leaseOwner, leaseToken],
      );
      if (current.rowCount !== 1) throw new Error('JOB_LEASE_LOST');
    };
    const currentRun = handler(
      { ...selected, attempts: 2, lease_token: currentToken },
      {
        leaseOwner,
        signal: controller.signal,
        assertLease: () => assertLease(currentToken),
      },
    );
    await currentDeliveryStarted;
    const afterCurrent = await authPool.query<{ digest: string }>(
      'SELECT digest FROM otp_challenge WHERE id = $1',
      [challenge.id],
    );
    let staleFailure: unknown;
    try {
      await handler(
        { ...selected, attempts: 1, lease_token: staleToken },
        {
          leaseOwner,
          signal: controller.signal,
          assertLease: () => assertLease(staleToken),
        },
      );
    } catch (error) {
      staleFailure = error;
    } finally {
      releaseCurrentDelivery();
      await currentRun;
    }
    const finalDigest = (
      await authPool.query<{ digest: string }>(
        'SELECT digest FROM otp_challenge WHERE id = $1',
        [challenge.id],
      )
    ).rows[0]?.digest;
    const deliveryCount = delivered.length;
    await workerPool.query('DELETE FROM job_queue WHERE id = $1', [selected.id]);
    await authPool.query('DELETE FROM otp_challenge WHERE id = $1', [challenge.id]);
    expect(staleFailure).toMatchObject({ message: 'JOB_LEASE_LOST' });
    expect(finalDigest).toBe(afterCurrent.rows[0]?.digest);
    expect(deliveryCount).toBe(1);
  });

  it('serializes concurrent resend attempts and locks after five failures', async () => {
    const attempts = await Promise.allSettled([
      createOtpChallenge({ ...base, email: 'viewer@example.com' }),
      createOtpChallenge({ ...base, email: 'viewer@example.com' }),
    ]);
    expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const challenge = attempts.find(({ status }) => status === 'fulfilled');
    if (challenge?.status !== 'fulfilled') throw new Error('challenge missing');
    const code = await deliverChallenge(challenge.value.id, clock);
    if (code === null) throw new Error('challenge code missing');
    for (let index = 0; index < 5; index += 1)
      expect(
        await consumeOtp({
          pool: authPool,
          challengeId: challenge.value.id,
          code: index === 0 && code === '00000000' ? '00000001' : '00000000',
          digestKey: base.digestKey,
          clock,
        }),
      ).toBeNull();
    expect(
      (
        await authPool.query<{ state: string }>(
          'SELECT state FROM otp_challenge WHERE id = $1',
          [challenge.value.id],
        )
      ).rows[0]?.state,
    ).toBe('locked');
  });
});

describe('sessions and immediate principal invalidation', () => {
  it('rolls real session and OTP mutations back when audit insertion fails', async () => {
    const clock = new FixedClock(new Date());
    const challenge = await createOtpChallenge({
      pool: authPool,
      email: 'viewer@example.com',
      normalizedIp: '192.0.2.20',
      digestKey: Buffer.alloc(32, 1).toString('base64url'),
      networkKey: Buffer.alloc(32, 2).toString('base64url'),
      client: { browser: 'other', os: 'other', device: 'other' },
      clock,
    });
    const code = await deliverChallenge(challenge.id, clock);
    if (code === null) throw new Error('challenge code missing');
    await migrationPool.query(`CREATE FUNCTION fail_test_audit_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected audit failure'; END $$`);
    await migrationPool.query(
      'CREATE TRIGGER fail_test_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION fail_test_audit_insert()',
    );
    try {
      await expect(
        issueSession(authPool, { kind: 'viewer', id: viewerId }, 'otp', clock),
      ).rejects.toThrow('injected audit failure');
      expect(
        (
          await authPool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM session WHERE viewer_id = $1 AND state = 'active'",
            [viewerId],
          )
        ).rows[0]?.n,
      ).toBe(0);
      await expect(
        consumeOtp({
          pool: authPool,
          challengeId: challenge.id,
          code,
          digestKey: Buffer.alloc(32, 1).toString('base64url'),
          clock,
        }),
      ).rejects.toThrow('injected audit failure');
      expect(
        (
          await authPool.query<{ state: string }>(
            'SELECT state FROM otp_challenge WHERE id = $1',
            [challenge.id],
          )
        ).rows[0]?.state,
      ).toBe('pending');
    } finally {
      await migrationPool.query('DROP TRIGGER fail_test_audit ON audit_event');
      await migrationPool.query('DROP FUNCTION fail_test_audit_insert()');
    }
  });

  it('rolls owner recovery back when audit insertion fails', async () => {
    const targetId = createOpaqueId();
    await migrationPool.query(
      "INSERT INTO member (id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state) VALUES ($1,'recovery@example.com','recovery@example.com','https://issuer.example','recovery','member','active')",
      [targetId],
    );
    await migrationPool.query(`CREATE FUNCTION fail_recovery_audit_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type = 'recovery.owner' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $$`);
    await migrationPool.query(
      'CREATE TRIGGER fail_recovery_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION fail_recovery_audit_insert()',
    );
    try {
      await expect(recoverOwner(authPool, 'recovery@example.com')).rejects.toThrow(
        'injected audit failure',
      );
      expect(
        (
          await runtimePool.query<{ global_role: string }>(
            'SELECT global_role FROM member WHERE id = $1',
            [targetId],
          )
        ).rows[0]?.global_role,
      ).toBe('member');
      expect(
        (
          await runtimePool.query<{ global_role: string }>(
            'SELECT global_role FROM member WHERE id = $1',
            [ownerId],
          )
        ).rows[0]?.global_role,
      ).toBe('owner');
    } finally {
      await migrationPool.query('DROP TRIGGER fail_recovery_audit ON audit_event');
      await migrationPool.query('DROP FUNCTION fail_recovery_audit_insert()');
    }
  });

  it('records the explicit authentication method and rotates/revokes families', async () => {
    const clock = new FixedClock(new Date('2026-03-01T00:00:00Z'));
    const first = await issueSession(authPool, { kind: 'viewer', id: viewerId }, 'otp', clock);
    const second = await rotateSession(
      authPool,
      first.secret,
      { kind: 'viewer', id: viewerId },
      'otp',
      clock,
    );
    expect(second.secret).not.toBe(first.secret);
    expect(await revokeSessionFamily(authPool, second.familyId)).toBe(1);
    const events = await runtimePool.query<{ event_type: string }>(
      'SELECT event_type FROM audit_event WHERE subject_id IN ($1,$2) ORDER BY sequence',
      [first.id, second.id],
    );
    expect(events.rows.map(({ event_type }) => event_type)).toEqual(['auth.otp', 'auth.otp']);
  });

  it('renews idle expiry on a bounded cadence and denies disabled/revoked principals next request', async () => {
    const clock = new FixedClock(new Date());
    const member = await issueSession(authPool, { kind: 'member', id: ownerId }, 'oidc', clock);
    const authenticate = createSessionAuthenticator(authPool, sessionPolicy);
    expect(await authenticate(sessionRequest(member.secret))).toMatchObject({
      principal: { kind: 'member', id: ownerId, globalRole: 'owner' },
    });
    await authPool.query(
      "UPDATE session SET last_seen_at = transaction_timestamp() - interval '6 minutes', idle_expires_at = transaction_timestamp() + interval '1 minute' WHERE id = $1",
      [member.id],
    );
    await authenticate(sessionRequest(member.secret));
    const renewed = await authPool.query<{ seconds: number }>(
      'SELECT extract(epoch from (idle_expires_at - transaction_timestamp()))::int AS seconds FROM session WHERE id = $1',
      [member.id],
    );
    expect(renewed.rows[0]?.seconds).toBeGreaterThan(1_700);

    const viewer = await issueSession(authPool, { kind: 'viewer', id: viewerId }, 'otp', clock);
    await migrationPool.query("UPDATE viewer SET state = 'revoked' WHERE id = $1", [viewerId]);
    expect(await authenticate(sessionRequest(viewer.secret))).toBeNull();

    const disabledMemberId = createOpaqueId();
    await migrationPool.query(
      "INSERT INTO member (id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state) VALUES ($1,'disabled@example.com','disabled@example.com','https://issuer.example','disabled','member','active')",
      [disabledMemberId],
    );
    const disabledMemberSession = await issueSession(
      authPool,
      { kind: 'member', id: disabledMemberId },
      'oidc',
      clock,
    );
    await migrationPool.query("UPDATE member SET state = 'disabled' WHERE id = $1", [
      disabledMemberId,
    ]);
    expect(await authenticate(sessionRequest(disabledMemberSession.secret))).toBeNull();
  });

  it('keeps OIDC freshness session-bound across independent logins', async () => {
    const loginAt = new Date();
    const staleAt = new Date(loginAt.getTime() - 30 * 60_000);
    const freshAt = loginAt;
    const first = await issueSession(
      authPool,
      { kind: 'member', id: ownerId, oidcAuthenticatedAt: staleAt },
      'oidc',
      new FixedClock(loginAt),
    );
    const second = await issueSession(
      authPool,
      { kind: 'member', id: ownerId, oidcAuthenticatedAt: freshAt },
      'oidc',
      new FixedClock(loginAt),
    );
    const authenticate = createSessionAuthenticator(authPool, sessionPolicy);
    expect(await authenticate(sessionRequest(first.secret))).toMatchObject({
      principal: { oidcAuthenticatedAt: staleAt },
    });
    expect(await authenticate(sessionRequest(second.secret))).toMatchObject({
      principal: { oidcAuthenticatedAt: freshAt },
    });
  });

  it('denies an idle-expired session instead of renewing it', async () => {
    const issued = await issueSession(
      authPool,
      { kind: 'viewer', id: viewerId },
      'otp',
      new FixedClock(new Date()),
    );
    await authPool.query(
      "UPDATE session SET last_seen_at = clock_timestamp() - interval '6 minutes', idle_expires_at = clock_timestamp() - interval '1 millisecond' WHERE id = $1",
      [issued.id],
    );
    expect(
      await createSessionAuthenticator(authPool, sessionPolicy)(sessionRequest(issued.secret)),
    ).toBeNull();
    expect(
      (
        await authPool.query<{ state: string }>('SELECT state FROM session WHERE id = $1', [
          issued.id,
        ])
      ).rows[0]?.state,
    ).toBe('active');
  });

  it('revokes every independent member session on sign-out all devices', async () => {
    const clock = new FixedClock(new Date());
    const first = await issueSession(authPool, { kind: 'member', id: ownerId }, 'oidc', clock);
    const second = await issueSession(authPool, { kind: 'member', id: ownerId }, 'oidc', clock);
    expect(first.familyId).not.toBe(second.familyId);
    expect(
      await revokePrincipalSessions(authPool, { kind: 'member', id: ownerId }),
    ).toBeGreaterThanOrEqual(2);
    const states = await authPool.query<{ state: string }>(
      'SELECT state FROM session WHERE id IN ($1,$2) ORDER BY id',
      [first.id, second.id],
    );
    expect(states.rows.map(({ state }) => state)).toEqual(['revoked', 'revoked']);
  });

  it('revokes sessions atomically for direct privilege changes', async () => {
    const memberId = createOpaqueId();
    await migrationPool.query(
      "INSERT INTO member (id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state) VALUES ($1,'member@example.com','member@example.com','https://issuer.example','member','member','active')",
      [memberId],
    );
    const issued = await issueSession(
      authPool,
      { kind: 'member', id: memberId },
      'oidc',
      new FixedClock(new Date()),
    );
    await migrationPool.query("UPDATE member SET global_role = 'admin' WHERE id = $1", [
      memberId,
    ]);
    expect(
      (
        await authPool.query<{ state: string }>('SELECT state FROM session WHERE id = $1', [
          issued.id,
        ])
      ).rows[0]?.state,
    ).toBe('revoked');
  });
});

describe('concurrent identity constraints and first-owner audit rollback', () => {
  it('allows exactly one concurrent first-owner claim', async () => {
    await migrateFresh();
    try {
      const claims = await Promise.allSettled(
        ['first@example.com', 'second@example.com'].map((email, index) =>
          claimFirstOwner({
            pool: authPool,
            identity: {
              issuer: 'https://issuer.example',
              subject: `subject-${index}`,
              emailKey: email,
              emailDisplay: email,
              authenticatedAt: new Date(),
              authenticationTimeAsserted: true,
            },
            allowlist: [email],
            organizationName: 'Concurrent',
            correlationId: createCorrelationId(),
          }),
        ),
      );
      expect(claims.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      expect(claims.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    } finally {
      await reset();
    }
  });

  it('lets one of two independent conflicting identity inserts commit', async () => {
    const first = await authPool.connect();
    const second = await authPool.connect();
    try {
      await first.query('BEGIN');
      await second.query('BEGIN');
      await first.query(
        "INSERT INTO member (id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state) VALUES ($1,'conflict@example.com','conflict@example.com','https://issuer.example','conflict-1','member','active')",
        [createOpaqueId()],
      );
      const blocked = second
        .query(
          "INSERT INTO member (id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state) VALUES ($1,'conflict@example.com','conflict@example.com','https://issuer.example','conflict-2','member','active')",
          [createOpaqueId()],
        )
        .then(
          () => null,
          (error: unknown) => error,
        );
      await first.query('COMMIT');
      expect(await blocked).toBeInstanceOf(Error);
      await second.query('ROLLBACK');
      expect(
        (
          await runtimePool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM member WHERE email_key = 'conflict@example.com'",
          )
        ).rows[0]?.n,
      ).toBe(1);
    } finally {
      first.release();
      second.release();
    }
  });

  it('rolls first-owner state back when its audit insert fails', async () => {
    await migrateFresh();
    await migrationPool.query(`CREATE FUNCTION fail_owner_audit_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected audit failure'; END $$`);
    await migrationPool.query(
      'CREATE TRIGGER fail_owner_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION fail_owner_audit_insert()',
    );
    try {
      await expect(
        claimFirstOwner({
          pool: authPool,
          identity: {
            issuer: 'https://issuer.example',
            subject: 'rollback-owner',
            emailKey: 'rollback-owner@example.com',
            emailDisplay: 'rollback-owner@example.com',
            authenticatedAt: new Date(),
            authenticationTimeAsserted: true,
          },
          allowlist: ['rollback-owner@example.com'],
          organizationName: 'Rollback',
          correlationId: createCorrelationId(),
        }),
      ).rejects.toThrow('injected audit failure');
      expect(
        (await runtimePool.query<{ n: number }>('SELECT count(*)::int AS n FROM organization'))
          .rows[0]?.n,
      ).toBe(0);
    } finally {
      await reset();
    }
  });
});

describe('durable worker leases', () => {
  it('claims once under concurrency and recovers an expired lease with fencing', async () => {
    const id = createOpaqueId();
    await workerPool.query(
      "INSERT INTO job_queue (id,job_type,idempotency_key,payload) VALUES ($1,'test.job',$2,'{}')",
      [id, createOpaqueId()],
    );
    let executions = 0;
    const handler = (): Promise<void> => {
      executions += 1;
      return Promise.resolve();
    };
    const handlers = new Map([['test.job', handler]]);
    const first = new JobRunner(workerPool, handlers);
    const second = new JobRunner(workerPool, handlers);
    await Promise.all([first.runOne(), second.runOne()]);
    expect(executions).toBe(1);

    const crashedId = createOpaqueId();
    await workerPool.query(
      `INSERT INTO job_queue
       (id,job_type,idempotency_key,payload,state,attempts,lease_owner,lease_token,lease_expires_at)
       VALUES ($1,'test.job',$2,'{}','running',1,$3,$4,transaction_timestamp() - interval '1 second')`,
      [crashedId, createOpaqueId(), createOpaqueId(), createOpaqueId()],
    );
    await first.runOne();
    expect(
      (
        await workerPool.query('SELECT state,attempts FROM job_queue WHERE id = $1', [
          crashedId,
        ])
      ).rows[0],
    ).toMatchObject({ state: 'succeeded', attempts: 2 });
  });

  it('terminalizes an expired final-attempt crash without executing it again', async () => {
    const id = createOpaqueId();
    await workerPool.query(
      `INSERT INTO job_queue
       (id,job_type,idempotency_key,payload,state,attempts,max_attempts,lease_owner,lease_token,lease_expires_at)
       VALUES ($1,'test.final',$2,'{}','running',1,1,$3,$4,clock_timestamp() - interval '1 second')`,
      [id, createOpaqueId(), createOpaqueId(), createOpaqueId()],
    );
    let executions = 0;
    const runner = new JobRunner(
      workerPool,
      new Map([
        [
          'test.final',
          () => {
            executions += 1;
            return Promise.resolve();
          },
        ],
      ]),
    );
    expect(await runner.runOne()).toBe(false);
    expect(executions).toBe(0);
    expect(
      (
        await workerPool.query<{ state: string; attempts: number }>(
          'SELECT state,attempts FROM job_queue WHERE id = $1',
          [id],
        )
      ).rows[0],
    ).toMatchObject({ state: 'failed', attempts: 1 });
  });

  it('does not let a second worker reclaim a live automatically heartbeated lease', async () => {
    const id = createOpaqueId();
    await workerPool.query(
      "INSERT INTO job_queue (id,job_type,idempotency_key,payload) VALUES ($1,'test.slow',$2,'{}')",
      [id, createOpaqueId()],
    );
    let release: (() => void) | undefined;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = new JobRunner(workerPool, new Map([['test.slow', () => blocker]]), {
      leaseSeconds: 1,
      heartbeatMilliseconds: 100,
    });
    const second = new JobRunner(workerPool, new Map([['test.slow', () => Promise.resolve()]]));
    const running = first.runOne();
    while (
      (
        await workerPool.query<{ state: string }>('SELECT state FROM job_queue WHERE id = $1', [
          id,
        ])
      ).rows[0]?.state !== 'running'
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(await second.runOne()).toBe(false);
    if (release === undefined) throw new Error('release missing');
    release();
    await running;
  });

  it('retries failures and stops at max attempts', async () => {
    const id = createOpaqueId();
    await workerPool.query(
      "INSERT INTO job_queue (id,job_type,idempotency_key,payload,max_attempts) VALUES ($1,'test.fail',$2,'{}',1)",
      [id, createOpaqueId()],
    );
    const runner = new JobRunner(
      workerPool,
      new Map([['test.fail', () => Promise.reject(new Error('fixture failure'))]]),
    );
    await runner.runOne();
    expect(
      (
        await workerPool.query<{ state: string }>('SELECT state FROM job_queue WHERE id = $1', [
          id,
        ])
      ).rows[0]?.state,
    ).toBe('failed');
  });
});
