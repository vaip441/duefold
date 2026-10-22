/**
 * Viewer invitation issue and OTP eligibility: what create_viewer_invitation accepts, what
 * it withdraws when it supersedes a lapsed invitation, who may still receive a code, and
 * that a wrong code reveals nothing about which addresses are invited.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import { FixedClock } from '@duefold/shared/clock';
import {
  consumeOtp,
  createOtpChallenge,
  OTP_MAX_ATTEMPTS,
} from '../../modules/core-security/src/auth/otp.ts';
import { createHandler as createRequiredMailHandler } from '../../modules/core-security/src/jobs/required-mail-delivery.ts';
import { deliverChallenge } from '../support/otp-delivery.ts';
import { workerPool } from './support/database.ts';
import {
  authPool,
  closeRoutePools,
  databasePool,
  migrationPool,
} from './support/route-fixture.ts';
import {
  resetRoomSchema,
  roomRevision,
  seedMember,
  seedRoom,
  staffRoom,
} from './support/room-fixture.ts';

let managerId: string;
let roomId: string;

beforeAll(async () => {
  const ownerId = await resetRoomSchema('Viewer invitation eligibility');
  managerId = await seedMember('member', 'eligibility.manager');
  roomId = await seedRoom(ownerId, 'Eligibility room');
  await staffRoom(managerId, roomId, 'manager', ownerId);
});

afterAll(closeRoutePools);

async function invite(emailKey: string, emailDisplay = emailKey) {
  const jobId = createOpaqueId();
  const row = (
    await databasePool.query<{ invitation_id: string; viewer_id: string }>(
      'SELECT * FROM create_viewer_invitation($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [
        createOpaqueId(),
        createOpaqueId(),
        createOpaqueId(),
        emailKey,
        emailDisplay,
        roomId,
        managerId,
        await roomRevision(roomId),
        jobId,
        createOpaqueId(),
        createCorrelationId(),
      ],
    )
  ).rows[0];
  if (row === undefined) throw new Error('VIEWER_INVITATION_ABSENT');
  return { ...row, jobId };
}

function challenge(email: string, at: Date) {
  return createOtpChallenge({
    pool: authPool,
    email,
    normalizedIp: '198.51.100.7',
    digestKey: 'd'.repeat(43),
    networkKey: 'n'.repeat(43),
    client: { browser: 'other', os: 'other', device: 'other' },
    clock: new FixedClock(at),
  });
}

async function challengeViewer(email: string, at: Date): Promise<string | null | undefined> {
  const { id } = await challenge(email, at);
  return (
    await migrationPool.query<{ viewer_id: string | null }>(
      'SELECT viewer_id FROM otp_challenge WHERE id=$1',
      [id],
    )
  ).rows[0]?.viewer_id;
}

describe('viewer invitation issue', () => {
  it('refuses a display address that does not normalize to the comparison key', async () => {
    await expect(invite('investor@example.test', 'other@example.test')).rejects.toMatchObject({
      code: '22023',
    });
  });

  it('withdraws the queued mail of a lapsed invitation it supersedes', async () => {
    const email = 'lapsed.mail@example.test';
    const first = await invite(email);
    await migrationPool.query(
      `UPDATE invitation SET created_at=transaction_timestamp()-interval '8 days',
         expires_at=transaction_timestamp()-interval '1 day' WHERE id=$1`,
      [first.invitation_id],
    );
    const second = await invite(email);
    const jobs = await migrationPool.query<{ id: string; state: string }>(
      "SELECT id,state FROM job_queue WHERE job_type='mail.viewer_invitation' AND id=ANY($1)",
      [[first.jobId, second.jobId]],
    );
    expect(jobs.rows).toEqual([{ id: second.jobId, state: 'pending' }]);
  });
});

describe('viewer OTP eligibility', () => {
  it('issues no code to an accepted viewer removed from every room', async () => {
    const email = 'removed.viewer@example.test';
    const issued = await invite(email);
    await migrationPool.query("UPDATE invitation SET state='accepted' WHERE id=$1", [
      issued.invitation_id,
    ]);
    const start = new Date();
    expect(await challengeViewer(email, start)).toBe(issued.viewer_id);

    await migrationPool.query('DELETE FROM viewer_room_membership WHERE viewer_id=$1', [
      issued.viewer_id,
    ]);
    expect(await challengeViewer(email, new Date(start.getTime() + 120_000))).toBeNull();
  });
});

/** Requests a code and runs its delivery job; the code is null when none was mailed. */
async function deliveredChallenge(email: string, at: Date) {
  const { id } = await challenge(email, at);
  return { id, code: await deliverChallenge(workerPool, id, new FixedClock(at)) };
}

describe('viewer OTP neutrality', () => {
  it('audits a code withheld from an uninvited address as not eligible, not as a delivery failure', async () => {
    const { id, code } = await deliveredChallenge('withheld@example.test', new Date());
    expect(code).toBeNull();
    expect(
      (
        await migrationPool.query(
          "SELECT result,reason_code FROM audit_event WHERE event_type='auth.otp' AND subject_id=$1 ORDER BY sequence",
          [id],
        )
      ).rows,
    ).toEqual([
      { result: 'success', reason_code: 'OTP_CHALLENGE_CREATED' },
      { result: 'denied', reason_code: 'OTP_NOT_ELIGIBLE' },
    ]);
  });

  it('records the same bounded wrong-code attempts for an invited and an uninvited address', async () => {
    const at = new Date();
    await invite('neutral.invited@example.test');
    const invited = await deliveredChallenge('neutral.invited@example.test', at);
    const uninvited = await deliveredChallenge('neutral.uninvited@example.test', at);
    expect(invited.code).not.toBeNull();
    expect(uninvited.code).toBeNull();
    const wrong = invited.code === '12345678' ? '87654321' : '12345678';
    for (const { id } of [invited, uninvited])
      for (let attempt = 0; attempt <= OTP_MAX_ATTEMPTS; attempt += 1)
        expect(
          await consumeOtp({
            pool: authPool,
            challengeId: id,
            code: wrong,
            digestKey: Buffer.alloc(32, 1).toString('base64url'),
            clock: new FixedClock(at),
          }),
        ).toBeNull();
    const recorded = await migrationPool.query<{ failed_attempts: number; denials: number }>(
      `SELECT o.failed_attempts,(SELECT count(*)::int FROM audit_event a
         WHERE a.subject_id=o.id AND a.reason_code='OTP_INVALID') denials
       FROM otp_challenge o WHERE o.id=ANY($1)`,
      [[invited.id, uninvited.id]],
    );
    expect(recorded.rows).toEqual([
      { failed_attempts: OTP_MAX_ATTEMPTS, denials: OTP_MAX_ATTEMPTS },
      { failed_attempts: OTP_MAX_ATTEMPTS, denials: OTP_MAX_ATTEMPTS },
    ]);
  });
});

describe('viewer invitation mail', () => {
  it('completes without mail when the invitation was accepted before delivery', async () => {
    const issued = await invite('accepted.mail@example.test');
    await migrationPool.query("UPDATE invitation SET state='accepted' WHERE id=$1", [
      issued.invitation_id,
    ]);
    const leaseOwner = 'accepted-mail-worker';
    const leaseToken = createOpaqueId();
    const payload = (
      await migrationPool.query<{ payload: Readonly<Record<string, unknown>> }>(
        `UPDATE job_queue SET state='running',attempts=attempts+1,lease_owner=$2,lease_token=$3,
           lease_expires_at=statement_timestamp()+interval '2 minutes'
         WHERE id=$1 RETURNING payload`,
        [issued.jobId, leaseOwner, leaseToken],
      )
    ).rows[0]?.payload;
    if (payload === undefined) throw new Error('JOB_NOT_LEASED');
    const unexpected = () => Promise.reject(new Error('MAIL_NOT_EXPECTED'));
    await expect(
      createRequiredMailHandler({
        pool: workerPool,
        mailer: {
          deliver: unexpected,
          deliverInvitation: unexpected,
          deliverOnboarding: unexpected,
          deliverSecurityNotice: unexpected,
          close: () => undefined,
        },
        publicUrl: 'https://duefold.example/',
      })(
        {
          id: issued.jobId,
          job_type: 'mail.viewer_invitation',
          payload,
          attempts: 1,
          max_attempts: 5,
          lease_token: leaseToken,
        },
        {
          leaseOwner,
          signal: new AbortController().signal,
          assertLease: () => Promise.resolve(),
        },
      ),
    ).resolves.toBeUndefined();
  });
});
