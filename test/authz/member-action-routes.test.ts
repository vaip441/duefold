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
  seedRouteFixture,
  type RouteFixture,
} from './support/route-fixture.ts';

let fixture: RouteFixture;
let ownerId: string;
let adminId: string;
let plainMemberId: string;
let targetMemberId: string;
let roomId: string;

beforeAll(async () => {
  fixture = await seedRouteFixture();
  ({ ownerId, adminId, plainMemberId, targetMemberId, roomId } = fixture);
});

afterAll(closeRoutePools);

describe('POST /api/members/actions', () => {
  /*
   * A DUPLICATE ADDRESS IS A REFUSAL THE ADMIN CAN ACT ON, NOT A FAULT.
   *
   * `invite_member` raises 23505 for an address that already holds a pending invitation
   * or already belongs to a member. That SQLSTATE was unmapped, so both reached the
   * Admin as HTTP 500 — a crash report for doing something entirely reasonable, and a
   * real fault would have been indistinguishable from it.
   *
   * Both cases are asserted, because they are different refusals in SQL (the member
   * check and the pending-invitation check) reaching the same mapping. The body is
   * asserted exactly: the database's wording must never be forwarded, or a duplicate
   * becomes a way to probe which addresses the installation already knows.
   */
  it('answers an already-invited or already-provisioned address as a conflict', async () => {
    const session = await memberSession(adminId);
    const instance = await app();
    for (const email of ['route.invited@example.test', 'route.member@example.test']) {
      const response = await instance.inject({
        method: 'POST',
        url: '/api/members/actions',
        headers: headers(session),
        payload: { action: 'invite', email, intendedRole: 'member' },
      });
      expect(response.statusCode, email).toBe(409);
      expect(response.json(), email).toStrictEqual({
        error: {
          code: 'CONFLICT',
          message: 'The resource changed before this request completed. Reload and try again.',
        },
      });
    }
    await instance.close();
  });

  it('denies an unauthenticated request before validating the body', async () => {
    const instance = await app();
    expect(
      (
        await instance.inject({
          method: 'POST',
          url: '/api/members/actions',
          payload: { action: 'invite', email: 'x@example.test', intendedRole: 'member' },
        })
      ).statusCode,
    ).toBe(401);
    await instance.close();
  });

  it('rejects a mutation without the CSRF header', async () => {
    const session = await memberSession(adminId);
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/members/actions',
      headers: headers(session, false),
      payload: { action: 'invite', email: 'csrf@example.test', intendedRole: 'member' },
    });
    expect(response.statusCode).toBe(403);
    expect(
      (
        await migrationPool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM invitation WHERE email_key='csrf@example.test'",
        )
      ).rows[0]?.count,
    ).toBe(0);
    await instance.close();
  });

  it('invites a member and enqueues its onboarding mail', async () => {
    const session = await memberSession(adminId);
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/members/actions',
      headers: headers(session),
      payload: { action: 'invite', email: ' Fresh@Example.test ', intendedRole: 'admin' },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json<{
      readonly invitationId: string;
      readonly intendedRole: string;
      readonly expiresAt: string;
    }>();
    expect(body.intendedRole).toBe('admin');
    expect(Number.isNaN(Date.parse(body.expiresAt))).toBe(false);
    expect(
      (
        await migrationPool.query<{ email_key: string; email_display: string }>(
          'SELECT email_key,email_display FROM invitation WHERE id=$1',
          [body.invitationId],
        )
      ).rows[0],
    ).toEqual({
      email_key: 'fresh@example.test',
      email_display: 'Fresh@Example.test',
    });
    expect(
      (
        await migrationPool.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM job_queue WHERE idempotency_key=$1',
          [`member-invitation:${body.invitationId}`],
        )
      ).rows[0]?.count,
    ).toBe(1);
    await instance.close();
  });

  it('refuses a plain member inviting anyone, uniformly', async () => {
    const session = await memberSession(plainMemberId);
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/members/actions',
      headers: headers(session),
      payload: { action: 'invite', email: 'nope@example.test', intendedRole: 'member' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toStrictEqual({
      error: { code: 'FORBIDDEN', message: 'This action is not available to you.' },
    });
    await instance.close();
  });

  it('revokes a pending invitation with no body', async () => {
    const invitationId = createOpaqueId();
    await databasePool.query('SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)', [
      invitationId,
      'route.revoke@example.test',
      'Route.Revoke@example.test',
      'member',
      ownerId,
      createOpaqueId(),
      createOpaqueId(),
      createCorrelationId(),
    ]);
    const session = await memberSession(adminId);
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/members/actions',
      headers: headers(session),
      payload: { action: 'revoke-invitation', invitationId },
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(
      (
        await migrationPool.query<{ state: string }>(
          'SELECT state FROM invitation WHERE id=$1',
          [invitationId],
        )
      ).rows[0]?.state,
    ).toBe('revoked');
    await instance.close();
  });

  it('changes a role and a state, returning the new revision each time', async () => {
    const session = await memberSession(ownerId);
    const instance = await app();
    const promoted = await instance.inject({
      method: 'POST',
      url: '/api/members/actions',
      headers: headers(session),
      payload: {
        action: 'set-role',
        memberId: targetMemberId,
        role: 'admin',
        expectedRevision: await currentRevision(targetMemberId),
      },
    });
    expect(promoted.statusCode).toBe(200);
    const promotedBody = promoted.json<{
      readonly memberId: string;
      readonly revision: number;
    }>();
    expect(promotedBody.memberId).toBe(targetMemberId);
    expect(promotedBody.revision).toBe(await currentRevision(targetMemberId));

    const disabled = await instance.inject({
      method: 'POST',
      url: '/api/members/actions',
      headers: headers(session),
      payload: {
        action: 'set-state',
        memberId: targetMemberId,
        state: 'disabled',
        expectedRevision: promotedBody.revision,
      },
    });
    expect(disabled.statusCode).toBe(200);
    expect(
      (
        await migrationPool.query<{ state: string; global_role: string }>(
          'SELECT state,global_role FROM member WHERE id=$1',
          [targetMemberId],
        )
      ).rows[0],
    ).toEqual({ state: 'disabled', global_role: 'admin' });

    const restored = await instance.inject({
      method: 'POST',
      url: '/api/members/actions',
      headers: headers(session),
      payload: {
        action: 'set-state',
        memberId: targetMemberId,
        state: 'active',
        expectedRevision: disabled.json<{ readonly revision: number }>().revision,
      },
    });
    expect(restored.statusCode).toBe(200);
    await instance.inject({
      method: 'POST',
      url: '/api/members/actions',
      headers: headers(session),
      payload: {
        action: 'set-role',
        memberId: targetMemberId,
        role: 'member',
        expectedRevision: restored.json<{ readonly revision: number }>().revision,
      },
    });
    await instance.close();
  });

  it('reports a stale revision as 409 and an Owner target as 403', async () => {
    const session = await memberSession(ownerId);
    const instance = await app();
    const stale = await instance.inject({
      method: 'POST',
      url: '/api/members/actions',
      headers: headers(session),
      payload: {
        action: 'set-role',
        memberId: targetMemberId,
        role: 'admin',
        expectedRevision: 999,
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'CONFLICT' } });
    const owner = await instance.inject({
      method: 'POST',
      url: '/api/members/actions',
      headers: headers(session),
      payload: {
        action: 'set-role',
        memberId: ownerId,
        role: 'admin',
        expectedRevision: await currentRevision(ownerId),
      },
    });
    expect(owner.statusCode).toBe(403);
    await instance.close();
  });

  it('assigns rooms in one batch and returns the complete resulting set', async () => {
    const session = await memberSession(ownerId);
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/members/actions',
      headers: headers(session),
      payload: {
        action: 'assign-rooms',
        memberId: targetMemberId,
        assign: [{ roomId, roomRole: 'contributor' }],
        revoke: [],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({
      memberId: targetMemberId,
      changed: 1,
      assignments: [{ roomId, roomRole: 'contributor' }],
    });
    const revoked = await instance.inject({
      method: 'POST',
      url: '/api/members/actions',
      headers: headers(session),
      payload: {
        action: 'assign-rooms',
        memberId: targetMemberId,
        assign: [],
        revoke: [roomId],
      },
    });
    expect(revoked.json()).toStrictEqual({
      memberId: targetMemberId,
      changed: 1,
      assignments: [],
    });
    await instance.close();
  });

  it('rejects an unknown action rather than defaulting', async () => {
    const session = await memberSession(adminId);
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/members/actions',
      headers: headers(session),
      payload: { action: 'delete-everything' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'REQUEST_INVALID' } });
    await instance.close();
  });

  it('rejects extra properties, wrong types, and out-of-set values in every action', async () => {
    const session = await memberSession(ownerId);
    const instance = await app();
    for (const payload of [
      { action: 'invite', email: 'x@example.test', intendedRole: 'owner' },
      { action: 'invite', email: 'x@example.test', intendedRole: 'member', extra: 1 },
      { action: 'invite', intendedRole: 'member' },
      { action: 'revoke-invitation', invitationId: 'short' },
      { action: 'set-role', memberId: targetMemberId, role: 'owner', expectedRevision: 1 },
      { action: 'set-role', memberId: targetMemberId, role: 'admin', expectedRevision: 0 },
      { action: 'set-role', memberId: targetMemberId, role: 'admin', expectedRevision: '1' },
      { action: 'set-state', memberId: targetMemberId, state: 'invited', expectedRevision: 1 },
      { action: 'transfer-dry-run', memberId: targetMemberId, confirmation: 'x' },
      { action: 'transfer-apply', memberId: targetMemberId, expectedRevision: 1 },
      {
        action: 'transfer-apply',
        memberId: targetMemberId,
        expectedRevision: 1,
        confirmation: 'TRANSFER OWNERSHIP',
      },
      {
        action: 'transfer-apply',
        memberId: targetMemberId,
        previewId: 'not-an-opaque-id',
        expectedRevision: 1,
        confirmation: 'TRANSFER OWNERSHIP',
      },
      {
        action: 'transfer-apply',
        memberId: targetMemberId,
        previewId: createOpaqueId(),
        expectedRevision: 1,
        confirmation: '',
      },
      {
        action: 'assign-rooms',
        memberId: targetMemberId,
        assign: [{ roomId, roomRole: 'owner' }],
        revoke: [],
      },
      {
        action: 'assign-rooms',
        memberId: targetMemberId,
        assign: [{ roomId }],
        revoke: [],
      },
      {
        action: 'assign-rooms',
        memberId: targetMemberId,
        assign: [{ roomId, roomRole: 'manager', extra: true }],
        revoke: [],
      },
      { action: 'assign-rooms', memberId: targetMemberId, assign: [], revoke: ['short'] },
      {
        action: 'assign-rooms',
        memberId: targetMemberId,
        assign: Array.from({ length: 101 }, () => ({ roomId, roomRole: 'manager' })),
        revoke: [],
      },
      { action: 'assign-rooms', memberId: targetMemberId, assign: [] },
    ])
      expect(
        (
          await instance.inject({
            method: 'POST',
            url: '/api/members/actions',
            headers: headers(session),
            payload,
          })
        ).statusCode,
        JSON.stringify(payload),
      ).toBe(400);
    await instance.close();
  });
});
