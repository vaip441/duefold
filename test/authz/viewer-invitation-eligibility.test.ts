/**
 * Viewer invitation issue and OTP eligibility: what create_viewer_invitation accepts, what
 * it withdraws when it supersedes a lapsed invitation, and who may still receive a code.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import { FixedClock } from '@duefold/shared/clock';
import { createOtpChallenge } from '../../modules/core-security/src/auth/otp.ts';
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

async function challengeViewer(email: string, at: Date): Promise<string | null | undefined> {
  const challenge = await createOtpChallenge({
    pool: authPool,
    email,
    normalizedIp: '198.51.100.7',
    digestKey: 'd'.repeat(43),
    networkKey: 'n'.repeat(43),
    client: { browser: 'other', os: 'other', device: 'other' },
    clock: new FixedClock(at),
  });
  return (
    await migrationPool.query<{ viewer_id: string | null }>(
      'SELECT viewer_id FROM otp_challenge WHERE id=$1',
      [challenge.id],
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
