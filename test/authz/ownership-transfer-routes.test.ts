import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import {
  app,
  closeRoutePools,
  currentRevision,
  databasePool,
  headers,
  memberSession,
  migrationPool,
  previewTransfer,
  restoreOwner,
  seedRouteFixture,
  type RouteFixture,
} from './support/route-fixture.ts';

let fixture: RouteFixture;
let ownerId: string;
let adminId: string;
let successorId: string;
let targetMemberId: string;
let roomId: string;

beforeAll(async () => {
  fixture = await seedRouteFixture();
  ({ ownerId, adminId, successorId, targetMemberId, roomId } = fixture);
});

afterAll(closeRoutePools);

describe('ownership transfer over HTTP', () => {
  it('previews the impact for the Owner and refuses an Admin', async () => {
    const ownerInstance = await app();
    const ownerRequest = await ownerInstance.inject({
      method: 'POST',
      url: '/api/members/actions',
      headers: headers(await memberSession(ownerId)),
      payload: { action: 'transfer-dry-run', memberId: successorId },
    });
    expect(ownerRequest.statusCode).toBe(200);
    const preview = ownerRequest.json<{
      readonly impact: {
        readonly previewId: string;
        readonly targetEmailDisplay: string;
        readonly confirmation: string;
        readonly message: string;
        readonly expectedRevision: number;
        readonly revokedAssignmentCount: number;
        readonly revokedAssignments: readonly unknown[];
        readonly revokedAssignmentsTruncated: boolean;
      };
    }>().impact;
    expect(preview).toMatchObject({
      targetEmailDisplay: 'Route.Successor@example.test',
      confirmation: 'TRANSFER OWNERSHIP',
      message:
        'You become an Admin, the named member becomes Owner, and both of you are signed out of every device because privileges changed.',
      expectedRevision: await currentRevision(successorId),
    });
    expect(preview.previewId).toMatch(/^[A-Za-z0-9_-]{32}$/u);
    expect(preview).toMatchObject({
      revokedAssignmentCount: 0,
      revokedAssignments: [],
      revokedAssignmentsTruncated: false,
    });
    const adminRequest = await ownerInstance.inject({
      method: 'POST',
      url: '/api/members/actions',
      headers: headers(await memberSession(adminId)),
      payload: { action: 'transfer-dry-run', memberId: successorId },
    });
    expect(adminRequest.statusCode).toBe(403);
    await ownerInstance.close();
  });

  it('refuses an apply that never previewed, and refuses to reuse one', async () => {
    const session = await memberSession(ownerId);
    const instance = await app();
    const unprevened = await instance.inject({
      method: 'POST',
      url: '/api/members/actions',
      headers: headers(session),
      payload: {
        action: 'transfer-apply',
        memberId: successorId,
        previewId: createOpaqueId(),
        expectedRevision: await currentRevision(successorId),
        confirmation: 'TRANSFER OWNERSHIP',
      },
    });
    expect(unprevened.statusCode).toBe(403);
    expect(unprevened.json()).toStrictEqual({
      error: { code: 'FORBIDDEN', message: 'This action is not available to you.' },
    });
    expect(
      (
        await migrationPool.query<{ global_role: string }>(
          'SELECT global_role FROM member WHERE id=$1',
          [ownerId],
        )
      ).rows[0]?.global_role,
    ).toBe('owner');

    const adminSession = await memberSession(adminId);
    const ownerPreview = await previewTransfer(instance, session, successorId);
    expect(
      (
        await instance.inject({
          method: 'POST',
          url: '/api/members/actions',
          headers: headers(adminSession),
          payload: {
            action: 'transfer-apply',
            memberId: successorId,
            previewId: ownerPreview.previewId,
            expectedRevision: ownerPreview.expectedRevision,
            confirmation: 'TRANSFER OWNERSHIP',
          },
        })
      ).statusCode,
    ).toBe(403);
    await instance.close();
  });

  it('names the successor\u2019s rooms and refuses an apply after they change', async () => {
    const session = await memberSession(ownerId);
    const instance = await app();
    try {
      await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
        targetMemberId,
        JSON.stringify([{ roomId, roomRole: 'manager' }]),
        JSON.stringify([]),
        ownerId,
        createOpaqueId(),
        createCorrelationId(),
      ]);
      const previewed = await instance.inject({
        method: 'POST',
        url: '/api/members/actions',
        headers: headers(session),
        payload: { action: 'transfer-dry-run', memberId: targetMemberId },
      });
      expect(previewed.statusCode).toBe(200);
      const impact = previewed.json<{
        readonly impact: {
          readonly previewId: string;
          readonly expectedRevision: number;
          readonly revokedAssignmentCount: number;
          readonly revokedAssignments: readonly {
            readonly roomId: string;
            readonly roomTitle: string;
            readonly roomRole: string;
          }[];
          readonly revokedAssignmentsTruncated: boolean;
        };
      }>().impact;
      expect(impact.revokedAssignmentCount).toBe(1);
      expect(impact.revokedAssignmentsTruncated).toBe(false);
      expect(impact.revokedAssignments).toEqual([
        { roomId, roomTitle: 'Route assignment room', roomRole: 'manager' },
      ]);

      const addedRoomId = createOpaqueId();
      await databasePool.query('SELECT create_room($1,$2,$3,$4,$5,$6)', [
        addedRoomId,
        'Route late room',
        '',
        ownerId,
        createOpaqueId(),
        createCorrelationId(),
      ]);
      await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
        targetMemberId,
        JSON.stringify([{ roomId: addedRoomId, roomRole: 'contributor' }]),
        JSON.stringify([]),
        ownerId,
        createOpaqueId(),
        createCorrelationId(),
      ]);
      expect(await currentRevision(targetMemberId)).toBe(impact.expectedRevision);

      const stale = await instance.inject({
        method: 'POST',
        url: '/api/members/actions',
        headers: headers(session),
        payload: {
          action: 'transfer-apply',
          memberId: targetMemberId,
          previewId: impact.previewId,
          expectedRevision: impact.expectedRevision,
          confirmation: 'TRANSFER OWNERSHIP',
        },
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toStrictEqual({
        error: {
          code: 'CONFLICT',
          message: 'The resource changed before this request completed. Reload and try again.',
        },
      });
      expect(
        (
          await migrationPool.query<{ global_role: string }>(
            'SELECT global_role FROM member WHERE id=$1',
            [ownerId],
          )
        ).rows[0]?.global_role,
      ).toBe('owner');
      expect(
        (
          await migrationPool.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM room_assignment
              WHERE member_id=$1 AND state='active'`,
            [targetMemberId],
          )
        ).rows[0]?.count,
      ).toBe(2);

      const rePreviewed = await instance.inject({
        method: 'POST',
        url: '/api/members/actions',
        headers: headers(session),
        payload: { action: 'transfer-dry-run', memberId: targetMemberId },
      });
      const reImpact = rePreviewed.json<{
        readonly impact: {
          readonly previewId: string;
          readonly expectedRevision: number;
          readonly revokedAssignmentCount: number;
        };
      }>().impact;
      expect(reImpact.revokedAssignmentCount).toBe(2);
      const applied = await instance.inject({
        method: 'POST',
        url: '/api/members/actions',
        headers: headers(session),
        payload: {
          action: 'transfer-apply',
          memberId: targetMemberId,
          previewId: reImpact.previewId,
          expectedRevision: reImpact.expectedRevision,
          confirmation: 'TRANSFER OWNERSHIP',
        },
      });
      expect(applied.statusCode).toBe(200);
      expect(applied.json()).toStrictEqual({ transferred: true, sessionEnded: true });
      expect(
        (
          await migrationPool.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM room_assignment
              WHERE member_id=$1 AND state='active'`,
            [targetMemberId],
          )
        ).rows[0]?.count,
      ).toBe(0);
      const events = (
        await migrationPool.query<{ event_type: string; reason_code: string }>(
          `SELECT event_type,reason_code FROM audit_event
            WHERE subject_id=$1 AND event_type IN ('ownership.transferred','room.assignment')
              AND reason_code IN ('OWNERSHIP_TRANSFERRED','ROOM_ASSIGNMENTS_SUPERSEDED')
            ORDER BY sequence DESC LIMIT 2`,
          [targetMemberId],
        )
      ).rows;
      expect(events.map(({ reason_code }) => reason_code).toSorted()).toEqual([
        'OWNERSHIP_TRANSFERRED',
        'ROOM_ASSIGNMENTS_SUPERSEDED',
      ]);
    } finally {
      await instance.close();
      await restoreOwner(ownerId, targetMemberId);
    }
  });

  it('refuses a mismatched confirmation as a request problem', async () => {
    const instance = await app();
    const session = await memberSession(ownerId);
    const preview = await previewTransfer(instance, session, successorId);
    const response = await instance.inject({
      method: 'POST',
      url: '/api/members/actions',
      headers: headers(session),
      payload: {
        action: 'transfer-apply',
        memberId: successorId,
        previewId: preview.previewId,
        expectedRevision: preview.expectedRevision,
        confirmation: 'transfer ownership',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(
      (
        await migrationPool.query<{ global_role: string }>(
          'SELECT global_role FROM member WHERE id=$1',
          [ownerId],
        )
      ).rows[0]?.global_role,
    ).toBe('owner');
    await instance.close();
  });

  it('refuses a confirmation padded with whitespace, without trimming it', async () => {
    const instance = await app();
    const session = await memberSession(ownerId);
    for (const confirmation of [
      ' TRANSFER OWNERSHIP',
      'TRANSFER OWNERSHIP ',
      '  TRANSFER OWNERSHIP  ',
      '\tTRANSFER OWNERSHIP',
      'TRANSFER OWNERSHIP\n',
      'TRANSFER  OWNERSHIP',
    ]) {
      const preview = await previewTransfer(instance, session, successorId);
      const response = await instance.inject({
        method: 'POST',
        url: '/api/members/actions',
        headers: headers(session),
        payload: {
          action: 'transfer-apply',
          memberId: successorId,
          previewId: preview.previewId,
          expectedRevision: preview.expectedRevision,
          confirmation,
        },
      });
      expect(response.statusCode, JSON.stringify(confirmation)).toBe(400);
      expect(
        (
          await migrationPool.query<{ global_role: string }>(
            'SELECT global_role FROM member WHERE id=$1',
            [ownerId],
          )
        ).rows[0]?.global_role,
        JSON.stringify(confirmation),
      ).toBe('owner');
    }
    await instance.close();
  });

  it('refuses ownership transfer on a stale authentication instant', async () => {
    const stale = await memberSession(ownerId, new Date(Date.now() - 30 * 60_000));
    const instance = await app();
    const preview = await previewTransfer(instance, stale, successorId);
    const response = await instance.inject({
      method: 'POST',
      url: '/api/members/actions',
      headers: headers(stale),
      payload: {
        action: 'transfer-apply',
        memberId: successorId,
        previewId: preview.previewId,
        expectedRevision: preview.expectedRevision,
        confirmation: 'TRANSFER OWNERSHIP',
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toStrictEqual({
      error: {
        code: 'FRESH_AUTHENTICATION_REQUIRED',
        message: 'This change needs a fresh sign-in.',
      },
    });
    await instance.close();
  });

  it('transfers ownership and reports the resulting sign-out', async () => {
    const session = await memberSession(ownerId);
    const instance = await app();
    const preview = await previewTransfer(instance, session, successorId);
    const response = await instance.inject({
      method: 'POST',
      url: '/api/members/actions',
      headers: headers(session),
      payload: {
        action: 'transfer-apply',
        memberId: successorId,
        previewId: preview.previewId,
        expectedRevision: preview.expectedRevision,
        confirmation: 'TRANSFER OWNERSHIP',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({ transferred: true, sessionEnded: true });
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
    expect(
      (
        await instance.inject({
          method: 'GET',
          url: '/api/members',
          headers: headers(session, false),
        })
      ).statusCode,
    ).toBe(401);
    await instance.close();
  });
});
