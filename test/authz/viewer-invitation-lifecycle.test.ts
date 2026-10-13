/**
 * Viewer invitations after the first: reissue, lapse, a second room, and who may accept.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOpaqueId } from '@duefold/shared/ids';
import {
  migrationPool,
  runtimePool,
  roomId,
  audit,
  roomRevision,
  managerId,
  otherRoomId,
  closeParticipantGrantPools,
  seedParticipantGrants,
} from './support/participant-grants-fixture.ts';

beforeAll(seedParticipantGrants);
afterAll(closeParticipantGrantPools);

describe('viewer re-invitation', () => {
  async function invite(email: string, room: string) {
    const jobId = createOpaqueId();
    const row = (
      await runtimePool.query<{ invitation_id: string; expires_at: Date }>(
        'SELECT * FROM create_viewer_invitation($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [
          createOpaqueId(),
          createOpaqueId(),
          createOpaqueId(),
          email,
          email,
          room,
          managerId,
          await roomRevision(room),
          jobId,
          ...audit(),
        ],
      )
    ).rows[0];
    if (row === undefined) throw new Error('VIEWER_INVITATION_ABSENT');
    return { ...row, jobId };
  }
  async function invitations(email: string) {
    return (
      await migrationPool.query<{ id: string; state: string }>(
        "SELECT id,state FROM invitation WHERE kind='viewer' AND email_key=$1 ORDER BY created_at,id",
        [email],
      )
    ).rows;
  }

  it('reissues an outstanding or lapsed invitation and invites an accepted viewer to another room', async () => {
    const email = 'reinvited@example.com';
    const first = await invite(email, roomId);
    const reissued = await invite(email, roomId);
    expect(reissued.invitation_id).toBe(first.invitation_id);
    expect(reissued.expires_at.getTime()).toBeGreaterThan(first.expires_at.getTime());
    expect(await invitations(email)).toEqual([{ id: first.invitation_id, state: 'pending' }]);
    expect(
      (
        await migrationPool.query<{ invitation_id: string }>(
          "SELECT payload->>'invitationId' invitation_id FROM job_queue WHERE id=$1 AND job_type='mail.viewer_invitation'",
          [reissued.jobId],
        )
      ).rows,
    ).toEqual([{ invitation_id: first.invitation_id }]);

    await migrationPool.query(
      `UPDATE invitation SET created_at=transaction_timestamp()-interval '8 days',
         expires_at=transaction_timestamp()-interval '1 day' WHERE id=$1`,
      [first.invitation_id],
    );
    const afterLapse = await invite(email, roomId);
    expect(await invitations(email)).toEqual([
      { id: first.invitation_id, state: 'expired' },
      { id: afterLapse.invitation_id, state: 'pending' },
    ]);
    expect(
      (
        await migrationPool.query(
          "SELECT 1 FROM audit_event WHERE resource_id=$1 AND reason_code='VIEWER_INVITATION_EXPIRED'",
          [first.invitation_id],
        )
      ).rowCount,
    ).toBe(1);

    await migrationPool.query("UPDATE invitation SET state='accepted' WHERE id=$1", [
      afterLapse.invitation_id,
    ]);
    const secondRoom = await invite(email, otherRoomId);
    expect(await invitations(email)).toEqual([
      { id: first.invitation_id, state: 'expired' },
      { id: afterLapse.invitation_id, state: 'accepted' },
      { id: secondRoom.invitation_id, state: 'pending' },
    ]);
    expect(
      (
        await migrationPool.query(
          `SELECT 1 FROM viewer_room_membership m JOIN viewer v ON v.id=m.viewer_id
           WHERE v.email_key=$1 AND m.room_id=$2 AND m.state='active'`,
          [email, otherRoomId],
        )
      ).rowCount,
    ).toBe(1);
  });
});

describe('viewer invitation acceptance boundary', () => {
  it('lets only the authenticator credential accept a viewer invitation', async () => {
    const signature = 'accept_viewer_invitation(text,text,text)';
    expect(
      (
        await migrationPool.query<{ owner: string }>(
          'SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid=$1::regprocedure',
          [signature],
        )
      ).rows[0]?.owner,
    ).toBe('duefold_migration');
    for (const [role, allowed] of [
      ['duefold_runtime', false],
      ['duefold_worker', false],
      ['duefold_authenticator', true],
    ] as const)
      expect(
        (
          await migrationPool.query<{ allowed: boolean }>(
            'SELECT has_function_privilege($1,$2,$3) allowed',
            [role, signature, 'EXECUTE'],
          )
        ).rows[0]?.allowed,
        `${role} EXECUTE ${signature}`,
      ).toBe(allowed);
  });
});
