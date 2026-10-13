/**
 * A viewer's first sign-in accepts their pending invitation, and an invitation left
 * unaccepted lapses after seven days, including across the 037 upgrade.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import { FixedClock } from '@duefold/shared/clock';
import { generatedMigrations } from '../../.duefold/generated/migrations.ts';
import { migrate } from '../../modules/core-security/src/db/migrate.ts';
import { consumeOtp, createOtpChallenge } from '../../modules/core-security/src/auth/otp.ts';
import {
  authPool,
  bootstrapPool,
  closePools,
  databasePool,
  migrationPool,
  workerPool,
} from '../authz/support/database.ts';
import { deliverChallenge } from '../support/otp-delivery.ts';

const viewerRoomId = createOpaqueId();

async function reset(migrations = generatedMigrations): Promise<void> {
  await bootstrapPool.query(
    'DROP SCHEMA public CASCADE; CREATE SCHEMA public; ALTER SCHEMA public OWNER TO duefold_migration;',
  );
  await migrate(migrationPool, migrations);
  const ownerId = createOpaqueId();
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
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await databasePool.query('SELECT create_room($1,$2,$3,$4,$5,$6)', [
    viewerRoomId,
    'Viewer room',
    '',
    ownerId,
    createOpaqueId(),
    createCorrelationId(),
  ]);
}
/** OTP issue requires a live room membership. */
async function addViewerToRoom(viewer: string): Promise<void> {
  await migrationPool.query(
    'INSERT INTO viewer_room_membership (id,viewer_id,room_id) VALUES ($1,$2,$3)',
    [createOpaqueId(), viewer, viewerRoomId],
  );
}

beforeAll(() => reset());
afterAll(closePools);

describe('viewer invitation acceptance at first sign-in', () => {
  const clock = new FixedClock(new Date());
  const base = {
    pool: authPool,
    digestKey: Buffer.alloc(32, 1).toString('base64url'),
    networkKey: Buffer.alloc(32, 2).toString('base64url'),
    client: { browser: 'firefox' as const, os: 'linux' as const, device: 'desktop' as const },
    clock,
  };
  async function invitedViewer(email: string): Promise<{ viewer: string; invitation: string }> {
    const viewer = createOpaqueId();
    const invitation = createOpaqueId();
    await migrationPool.query(
      'INSERT INTO viewer (id,email_key,email_display,session_family_id) VALUES ($1,$2,$2,$3)',
      [viewer, email, createOpaqueId()],
    );
    await migrationPool.query(
      "INSERT INTO invitation (id,kind,email_key,email_display,state,expires_at) VALUES ($1,'viewer',$2,$2,'pending',transaction_timestamp() + interval '7 days')",
      [invitation, email],
    );
    await addViewerToRoom(viewer);
    return { viewer, invitation };
  }
  async function ageInvitations(email: string): Promise<void> {
    await migrationPool.query(
      `UPDATE invitation SET created_at = transaction_timestamp() - interval '8 days',
         expires_at = transaction_timestamp() - interval '1 day'
       WHERE kind = 'viewer' AND email_key = $1`,
      [email],
    );
  }
  async function signIn(email: string, normalizedIp: string): Promise<string | null> {
    const challenge = await createOtpChallenge({ ...base, email, normalizedIp });
    const code = await deliverChallenge(workerPool, challenge.id, clock);
    if (code === null) return null;
    const viewer = await consumeOtp({
      pool: authPool,
      challengeId: challenge.id,
      code,
      digestKey: base.digestKey,
      clock,
    });
    return viewer?.id ?? null;
  }
  async function invitationStates(email: string): Promise<readonly string[]> {
    return (
      await migrationPool.query<{ state: string }>(
        "SELECT state FROM invitation WHERE kind = 'viewer' AND email_key = $1 ORDER BY state",
        [email],
      )
    ).rows.map((row) => row.state);
  }

  it('accepts the invitation once and keeps the viewer eligible after the seven-day window', async () => {
    const email = 'accepting.viewer@example.com';
    const { viewer, invitation } = await invitedViewer(email);
    expect(await signIn(email, '192.0.2.61')).toBe(viewer);
    expect(await invitationStates(email)).toEqual(['accepted']);
    expect(
      (
        await migrationPool.query(
          `SELECT 1 FROM audit_event WHERE event_type = 'invitation.accepted'
             AND resource_id = $1 AND actor_id = $2 AND reason_code = 'VIEWER_INVITATION_ACCEPTED'`,
          [invitation, viewer],
        )
      ).rowCount,
    ).toBe(1);

    await ageInvitations(email);
    // A later room invitation adds a pending row; signing in again must not try to
    // accept it alongside the existing acceptance.
    await migrationPool.query(
      "INSERT INTO invitation (id,kind,email_key,email_display,state,expires_at) VALUES ($1,'viewer',$2,$2,'pending',transaction_timestamp() + interval '7 days')",
      [createOpaqueId(), email],
    );
    expect(await signIn(email, '192.0.2.62')).toBe(viewer);
    expect(await invitationStates(email)).toEqual(['accepted', 'pending']);
  });

  it('issues no code for an invitation left unaccepted past seven days', async () => {
    const email = 'lapsed.viewer@example.com';
    await invitedViewer(email);
    await ageInvitations(email);
    expect(await signIn(email, '192.0.2.63')).toBeNull();
    expect(await invitationStates(email)).toEqual(['pending']);
  });

  it('accepts on upgrade the lapsed invitation of a viewer who signed in before 037', async () => {
    const email = 'upgraded.viewer@example.com';
    try {
      await reset(generatedMigrations.filter(({ id }) => id < '037'));
      const { viewer, invitation } = await invitedViewer(email);
      await ageInvitations(email);
      await migrationPool.query(
        `INSERT INTO otp_challenge (id,email_key,viewer_id,digest,state,network_period,network_hmac,
           browser_category,os_category,device_category,expires_at,created_at)
         VALUES ($1,$2,$3,$4,'consumed','2026-10',$4,'firefox','linux','desktop',
           transaction_timestamp() - interval '7 days' + interval '10 minutes',
           transaction_timestamp() - interval '7 days')`,
        [createOpaqueId(), email, viewer, '0'.repeat(64)],
      );
      await migrate(migrationPool, generatedMigrations);
      expect(await invitationStates(email)).toEqual(['accepted']);
      expect(
        (
          await migrationPool.query(
            `SELECT 1 FROM audit_event WHERE event_type = 'invitation.accepted'
               AND resource_id = $1 AND subject_id = $2 AND actor_kind = 'system'`,
            [invitation, viewer],
          )
        ).rowCount,
      ).toBe(1);
      expect(await signIn(email, '192.0.2.64')).toBe(viewer);
    } finally {
      await reset();
    }
  });
});
