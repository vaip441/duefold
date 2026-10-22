/**
 * Guarded owner recovery leaves the recovered Owner no explicit room assignment, as an
 * ownership transfer does, and ends the sessions of both members whose role changed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock } from '@duefold/shared/clock';
import { recoverOwner } from '../../modules/core-security/src/recovery.ts';
import { issueSession } from '../../modules/core-security/src/sessions.ts';
import { authPool, closePools, migrationPool } from '../authz/support/database.ts';
import {
  resetRoomSchema,
  seedMember,
  seedRoom,
  staffRoom,
} from '../authz/support/room-fixture.ts';

let ownerId: string;
let targetId: string;
let roomId: string;

beforeAll(async () => {
  ownerId = await resetRoomSchema('Owner recovery');
  targetId = await seedMember('member', 'recovery.target');
  roomId = await seedRoom(ownerId, 'Recovery room');
  await staffRoom(targetId, roomId, 'manager', ownerId);
});
afterAll(closePools);

describe('owner recovery', () => {
  it("supersedes the recovered Owner's room assignments and ends both members' sessions", async () => {
    const clock = new FixedClock(new Date());
    const sessions = await Promise.all(
      [ownerId, targetId].map((id) =>
        issueSession(authPool, { kind: 'member', id }, 'oidc', clock),
      ),
    );

    await recoverOwner(migrationPool, 'recovery.target@example.test');

    expect(
      (
        await migrationPool.query('SELECT state FROM room_assignment WHERE member_id=$1', [
          targetId,
        ])
      ).rows,
    ).toEqual([{ state: 'revoked' }]);
    const audit = await migrationPool.query<{ correlation_id: string }>(
      `SELECT reason_code,actor_kind,detail,correlation_id FROM audit_event
       WHERE subject_id=$1 AND reason_code IN ('ROOM_ASSIGNMENTS_SUPERSEDED','CLI_RECOVERY')
       ORDER BY sequence`,
      [targetId],
    );
    const correlationId = audit.rows[0]?.correlation_id;
    expect(audit.rows).toEqual([
      {
        reason_code: 'ROOM_ASSIGNMENTS_SUPERSEDED',
        actor_kind: 'operator',
        detail: {
          revoked: [{ roomId, roomRole: 'manager' }],
          reason: 'global_role',
          toRole: 'owner',
        },
        correlation_id: correlationId,
      },
      {
        reason_code: 'CLI_RECOVERY',
        actor_kind: 'operator',
        detail: { backup_acknowledged: true },
        correlation_id: correlationId,
      },
    ]);
    expect(
      (
        await migrationPool.query('SELECT DISTINCT state FROM session WHERE id=ANY($1)', [
          sessions.map(({ id }) => id),
        ])
      ).rows,
    ).toEqual([{ state: 'revoked' }]);
  });
});
