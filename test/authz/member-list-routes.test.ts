import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import {
  app,
  closeRoutePools,
  databasePool,
  headers,
  memberSession,
  migrationPool,
  seedRouteFixture,
  viewerCookie,
  type RouteFixture,
} from './support/route-fixture.ts';

let fixture: RouteFixture;
let ownerId: string;
let adminId: string;
let plainMemberId: string;
let targetMemberId: string;
let viewerId: string;
let roomId: string;
let pendingInvitationId: string;
let bulkRoomIds: readonly string[];
let bulkMemberIds: readonly string[];

beforeAll(async () => {
  fixture = await seedRouteFixture({ bulkRooms: true });
  ({
    ownerId,
    adminId,
    plainMemberId,
    targetMemberId,
    viewerId,
    roomId,
    pendingInvitationId,
    bulkRoomIds,
    bulkMemberIds,
  } = fixture);
});

afterAll(closeRoutePools);

describe('GET /api/members', () => {
  it('denies an unauthenticated request', async () => {
    const instance = await app();
    expect((await instance.inject({ method: 'GET', url: '/api/members' })).statusCode).toBe(
      401,
    );
    await instance.close();
  });

  it('denies a viewer session at the audience guard', async () => {
    const instance = await app();
    expect(
      (
        await instance.inject({
          method: 'GET',
          url: '/api/members',
          headers: await viewerCookie(viewerId),
        })
      ).statusCode,
    ).toBe(401);
    await instance.close();
  });

  it('denies a plain member without disclosing whether members exist', async () => {
    const session = await memberSession(plainMemberId);
    const instance = await app();
    const response = await instance.inject({
      method: 'GET',
      url: '/api/members',
      headers: headers(session, false),
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain('@');
    expect(response.json()).toStrictEqual({
      error: { code: 'FORBIDDEN', message: 'This action is not available to you.' },
    });
    await instance.close();
  });

  it('lists members with assignments and pending invitations for an Admin', async () => {
    await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
      targetMemberId,
      JSON.stringify([{ roomId, roomRole: 'manager' }]),
      JSON.stringify([]),
      ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    const session = await memberSession(adminId);
    const instance = await app();
    const response = await instance.inject({
      method: 'GET',
      url: '/api/members',
      headers: headers(session, false),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      readonly subjects: readonly {
        readonly subjectKind: string;
        readonly subjectId: string;
        readonly state: string;
        readonly globalRole: string;
        readonly assignments?: readonly {
          readonly roomId: string;
          readonly roomRole: string;
        }[];
      }[];
    }>();
    const invitation = body.subjects.find(({ subjectId }) => subjectId === pendingInvitationId);
    expect(invitation).toMatchObject({
      subjectKind: 'invitation',
      state: 'pending',
      globalRole: 'member',
    });
    expect(invitation).not.toHaveProperty('assignments');
    expect(body.subjects.find(({ subjectId }) => subjectId === targetMemberId)).toMatchObject({
      subjectKind: 'member',
      state: 'active',
      assignments: [{ roomId, roomRole: 'manager' }],
    });
    expect(body.subjects.find(({ subjectId }) => subjectId === ownerId)).toMatchObject({
      globalRole: 'owner',
    });
    await instance.close();
    await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
      targetMemberId,
      JSON.stringify([]),
      JSON.stringify([roomId]),
      ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);
  });

  it('tells an Admin they may not transfer ownership, nor administer themselves', async () => {
    const session = await memberSession(adminId);
    const instance = await app();
    const body = (
      await instance.inject({
        method: 'GET',
        url: '/api/members',
        headers: headers(session, false),
      })
    ).json<{
      readonly subjects: readonly {
        readonly subjectId: string;
        readonly capabilities: Readonly<Record<string, boolean>>;
      }[];
    }>();
    const capabilitiesFor = (id: string) =>
      body.subjects.find(({ subjectId }) => subjectId === id)?.capabilities;

    expect(capabilitiesFor(targetMemberId)).toStrictEqual({
      setRole: true,
      setState: true,
      assignRooms: true,
      transfer: false,
    });
    expect(capabilitiesFor(adminId)).toStrictEqual({
      setRole: false,
      setState: false,
      assignRooms: false,
      transfer: false,
    });
    expect(capabilitiesFor(ownerId)).toStrictEqual({
      setRole: false,
      setState: false,
      assignRooms: false,
      transfer: false,
    });
    await instance.close();
  });

  it('offers the Owner transfer to an eligible successor but not to themselves', async () => {
    const session = await memberSession(ownerId);
    const instance = await app();
    const body = (
      await instance.inject({
        method: 'GET',
        url: '/api/members',
        headers: headers(session, false),
      })
    ).json<{
      readonly subjects: readonly {
        readonly subjectId: string;
        readonly capabilities: Readonly<Record<string, boolean>>;
      }[];
    }>();
    const capabilitiesFor = (id: string) =>
      body.subjects.find(({ subjectId }) => subjectId === id)?.capabilities;

    expect(capabilitiesFor(targetMemberId)?.['transfer']).toBe(true);
    expect(capabilitiesFor(ownerId)).toStrictEqual({
      setRole: false,
      setState: false,
      assignRooms: false,
      transfer: false,
    });
    await instance.close();
  });

  it('carries NO capability set on a pending invitation, not an all-false one', async () => {
    const session = await memberSession(ownerId);
    const instance = await app();
    const body = (
      await instance.inject({
        method: 'GET',
        url: '/api/members',
        headers: headers(session, false),
      })
    ).json<{
      readonly subjects: readonly { readonly subjectKind: string }[];
    }>();
    const invitations = body.subjects.filter(({ subjectKind }) => subjectKind === 'invitation');
    expect(invitations.length).toBeGreaterThan(0);
    for (const subject of invitations) expect(subject).not.toHaveProperty('capabilities');
    await instance.close();
  });

  it('returns a bounded page with a cursor and walks the collection without loss', async () => {
    const session = await memberSession(adminId);
    const instance = await app();
    const page = async (query: string) =>
      instance.inject({
        method: 'GET',
        url: `/api/members${query}`,
        headers: headers(session, false),
      });
    const full = (await page('?limit=100')).json<{
      readonly subjects: readonly { readonly subjectId: string }[];
    }>();
    expect(full.subjects.length).toBeGreaterThan(2);

    const first = await page('?limit=1');
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<{
      readonly subjects: readonly { readonly subjectId: string }[];
      readonly nextCursor?: { readonly createdAt: string; readonly subjectId: string };
    }>();
    expect(firstBody.subjects).toHaveLength(1);
    expect(firstBody.nextCursor).toBeDefined();

    const walked: string[] = [...firstBody.subjects.map(({ subjectId }) => subjectId)];
    let cursor = firstBody.nextCursor;
    for (let step = 0; step < full.subjects.length + 5 && cursor !== undefined; step += 1) {
      const next = await page(
        `?limit=1&afterCreatedAt=${encodeURIComponent(cursor.createdAt)}` +
          `&afterSubjectId=${cursor.subjectId}`,
      );
      expect(next.statusCode).toBe(200);
      const body = next.json<{
        readonly subjects: readonly { readonly subjectId: string }[];
        readonly nextCursor?: { readonly createdAt: string; readonly subjectId: string };
      }>();
      walked.push(...body.subjects.map(({ subjectId }) => subjectId));
      cursor = body.nextCursor;
    }
    expect(walked).toEqual(full.subjects.map(({ subjectId }) => subjectId));
    expect(cursor).toBeUndefined();
    await instance.close();
  });

  describe('with more active assignments than one page can carry', () => {
    beforeAll(async () => {
      for (const memberId of bulkMemberIds)
        for (let offset = 0; offset < bulkRoomIds.length; offset += 100)
          await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
            memberId,
            JSON.stringify(
              bulkRoomIds
                .slice(offset, offset + 100)
                .map((bulkRoomId) => ({ roomId: bulkRoomId, roomRole: 'contributor' })),
            ),
            JSON.stringify([]),
            ownerId,
            createOpaqueId(),
            createCorrelationId(),
          ]);
    });

    afterAll(async () => {
      await migrationPool.query(
        "UPDATE room_assignment SET state='revoked' WHERE member_id = ANY($1) AND state='active'",
        [[...bulkMemberIds]],
      );
    });

    it('returns every member\u2019s complete assignment set while walking a budget-bounded collection', async () => {
      const session = await memberSession(adminId);
      const instance = await app();
      interface Body {
        readonly subjects: readonly {
          readonly subjectId: string;
          readonly assignments: readonly {
            readonly roomId: string;
            readonly roomRole: string;
          }[];
        }[];
        readonly nextCursor?: { readonly createdAt: string; readonly subjectId: string };
      }
      const page = async (cursor?: {
        readonly createdAt: string;
        readonly subjectId: string;
      }): Promise<{ readonly status: number; readonly body: Body }> => {
        const response = await instance.inject({
          method: 'GET',
          url:
            '/api/members?limit=100' +
            (cursor === undefined
              ? ''
              : `&afterCreatedAt=${encodeURIComponent(cursor.createdAt)}` +
                `&afterSubjectId=${cursor.subjectId}`),
          headers: headers(session, false),
        });
        return { status: response.statusCode, body: response.json<Body>() };
      };

      const total = (
        await migrationPool.query<{ count: number }>(
          `SELECT ((SELECT count(*) FROM member)
                 + (SELECT count(*) FROM invitation
                     WHERE kind='member' AND state='pending'
                       AND expires_at>statement_timestamp()))::int AS count`,
        )
      ).rows[0]?.count;
      if (total === undefined) throw new Error('subject total unavailable');
      expect(total).toBeLessThan(100);
      expect(
        (
          await migrationPool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM room_assignment WHERE state='active'",
          )
        ).rows[0]?.count,
      ).toBeGreaterThan(500);

      const walked: string[] = [];
      let cursor: { readonly createdAt: string; readonly subjectId: string } | undefined;
      let pages = 0;
      for (;;) {
        const { status, body } = await page(cursor);
        pages += 1;
        expect(status).toBe(200);
        expect(body.subjects.length).toBeGreaterThan(0);
        for (const subject of body.subjects) {
          walked.push(subject.subjectId);
          if (bulkMemberIds.includes(subject.subjectId))
            expect(subject.assignments, subject.subjectId).toHaveLength(bulkRoomIds.length);
        }
        if (body.nextCursor === undefined) break;
        expect(body.subjects.length).toBeLessThan(100);
        cursor = body.nextCursor;
        expect(pages).toBeLessThan(20);
      }
      expect(pages).toBeGreaterThan(1);
      expect(walked).toHaveLength(total);
      expect(new Set(walked).size).toBe(walked.length);
      await instance.close();
    });

    it('walks one subject at a time without stalling on a heavily staffed member', async () => {
      const session = await memberSession(adminId);
      const instance = await app();
      const walked: string[] = [];
      let cursor: { readonly createdAt: string; readonly subjectId: string } | undefined;
      for (let step = 0; step < 40; step += 1) {
        const response = await instance.inject({
          method: 'GET',
          url:
            '/api/members?limit=1' +
            (cursor === undefined
              ? ''
              : `&afterCreatedAt=${encodeURIComponent(cursor.createdAt)}` +
                `&afterSubjectId=${cursor.subjectId}`),
          headers: headers(session, false),
        });
        expect(response.statusCode).toBe(200);
        const body = response.json<{
          readonly subjects: readonly {
            readonly subjectId: string;
            readonly assignments: readonly unknown[];
          }[];
          readonly nextCursor?: { readonly createdAt: string; readonly subjectId: string };
        }>();
        expect(body.subjects).toHaveLength(1);
        const subject = body.subjects[0];
        if (subject === undefined) throw new Error('page unexpectedly empty');
        walked.push(subject.subjectId);
        if (bulkMemberIds.includes(subject.subjectId))
          expect(subject.assignments, subject.subjectId).toHaveLength(bulkRoomIds.length);
        if (body.nextCursor === undefined) break;
        cursor = body.nextCursor;
      }
      expect(new Set(walked).size).toBe(walked.length);
      expect(walked.length).toBeGreaterThan(bulkMemberIds.length);
      await instance.close();
    });
  });

  it('offers no cursor on a final page that exactly fills the limit', async () => {
    const session = await memberSession(adminId);
    const instance = await app();
    const total = (
      await instance.inject({
        method: 'GET',
        url: '/api/members?limit=100',
        headers: headers(session, false),
      })
    ).json<{ readonly subjects: readonly unknown[] }>().subjects.length;
    expect(total).toBeGreaterThan(1);

    const exact = await instance.inject({
      method: 'GET',
      url: `/api/members?limit=${total}`,
      headers: headers(session, false),
    });
    expect(exact.statusCode).toBe(200);
    const exactBody = exact.json<{
      readonly subjects: readonly unknown[];
      readonly nextCursor?: unknown;
    }>();
    expect(exactBody.subjects).toHaveLength(total);
    expect(exactBody.nextCursor).toBeUndefined();

    const partial = await instance.inject({
      method: 'GET',
      url: `/api/members?limit=${total - 1}`,
      headers: headers(session, false),
    });
    const partialBody = partial.json<{
      readonly subjects: readonly unknown[];
      readonly nextCursor?: { readonly createdAt: string; readonly subjectId: string };
    }>();
    expect(partialBody.subjects).toHaveLength(total - 1);
    expect(partialBody.nextCursor).toBeDefined();
    const cursor = partialBody.nextCursor;
    if (cursor === undefined) throw new Error('cursor missing');
    const last = await instance.inject({
      method: 'GET',
      url:
        `/api/members?limit=${total - 1}` +
        `&afterCreatedAt=${encodeURIComponent(cursor.createdAt)}` +
        `&afterSubjectId=${cursor.subjectId}`,
      headers: headers(session, false),
    });
    const lastBody = last.json<{
      readonly subjects: readonly unknown[];
      readonly nextCursor?: unknown;
    }>();
    expect(lastBody.subjects).toHaveLength(1);
    expect(lastBody.nextCursor).toBeUndefined();
    await instance.close();
  });

  it('rejects an oversized page, a non-numeric page, and half a cursor', async () => {
    const session = await memberSession(adminId);
    const instance = await app();
    for (const query of [
      '?limit=101',
      '?limit=0',
      '?limit=-1',
      '?limit=all',
      `?afterCreatedAt=${encodeURIComponent('2026-01-01 00:00:00+00')}`,
      `?afterSubjectId=${createOpaqueId()}`,
      '?unexpected=1',
    ])
      expect(
        (
          await instance.inject({
            method: 'GET',
            url: `/api/members${query}`,
            headers: headers(session, false),
          })
        ).statusCode,
        query,
      ).toBe(400);
    await instance.close();
  });

  it('fails closed rather than rendering a member state it does not recognize', async () => {
    const strangeId = createOpaqueId();
    await migrationPool.query(
      `INSERT INTO member
       (id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state)
       VALUES ($1,'route.strange@example.test','Route.Strange@example.test',
               'https://issuer.example','route-strange','member','invited')`,
      [strangeId],
    );
    const instance = await app();
    try {
      const response = await instance.inject({
        method: 'GET',
        url: '/api/members',
        headers: headers(await memberSession(adminId), false),
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toStrictEqual({
        error: { code: 'INTERNAL', message: 'The request could not be completed.' },
      });
      expect(response.body).not.toContain('@');
    } finally {
      await instance.close();
      await migrationPool.query('DELETE FROM member WHERE id=$1', [strangeId]);
    }
  });
});

describe('GET /api/rooms as the staffing register', () => {
  it('bounds a page and states continuation rather than implying it from fullness', async () => {
    const session = await memberSession(ownerId);
    const instance = await app();
    const response = await instance.inject({
      method: 'GET',
      url: '/api/rooms?limit=2',
      headers: headers(session, false),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      readonly rooms: readonly { readonly roomId: string; readonly title: string }[];
      readonly nextCursor?: { readonly title: string; readonly roomId: string };
    }>();
    expect(body.rooms).toHaveLength(2);
    expect(body.nextCursor).toBeDefined();
    expect(body.nextCursor?.title).toBe(body.rooms.at(-1)?.title);
    expect(body.nextCursor?.roomId).toBe(body.rooms.at(-1)?.roomId);
    await instance.close();
  });

  it('walks the whole register without loss and ends with no cursor', async () => {
    const session = await memberSession(ownerId);
    const instance = await app();
    const page = async (query: string) =>
      instance.inject({
        method: 'GET',
        url: `/api/rooms${query}`,
        headers: headers(session, false),
      });
    interface Body {
      readonly rooms: readonly { readonly roomId: string }[];
      readonly nextCursor?: { readonly title: string; readonly roomId: string };
    }
    const walked: string[] = [];
    let cursor: { readonly title: string; readonly roomId: string } | undefined;
    let pages = 0;
    for (;;) {
      const response = await page(
        '?limit=100' +
          (cursor === undefined
            ? ''
            : `&afterTitle=${encodeURIComponent(cursor.title)}` +
              `&afterRoomId=${cursor.roomId}`),
      );
      expect(response.statusCode).toBe(200);
      const body = response.json<Body>();
      pages += 1;
      expect(body.rooms.length).toBeGreaterThan(0);
      walked.push(...body.rooms.map(({ roomId: id }) => id));
      if (body.nextCursor === undefined) break;
      cursor = body.nextCursor;
      expect(pages).toBeLessThan(10);
    }
    expect(pages).toBeGreaterThan(1);
    expect(walked).toHaveLength(bulkRoomIds.length + 1);
    expect(new Set(walked).size).toBe(walked.length);
    for (const bulkRoomId of bulkRoomIds) expect(walked).toContain(bulkRoomId);
    await instance.close();
  });

  it('refuses half a cursor as an invalid request rather than a fault', async () => {
    const session = await memberSession(ownerId);
    const instance = await app();
    for (const query of [
      '?afterTitle=Bulk%20room%20000',
      `?afterRoomId=${bulkRoomIds[0] ?? ''}`,
      '?limit=10&afterTitle=Bulk%20room%20000',
    ]) {
      const response = await instance.inject({
        method: 'GET',
        url: `/api/rooms${query}`,
        headers: headers(session, false),
      });
      expect(response.statusCode, query).toBe(400);
      expect(response.json(), query).toMatchObject({ error: { code: 'REQUEST_INVALID' } });
    }
    await instance.close();
  });

  it('refuses a limit outside the bound and an unknown parameter', async () => {
    const session = await memberSession(ownerId);
    const instance = await app();
    for (const query of ['?limit=0', '?limit=101', '?limit=abc', '?unexpected=1'])
      expect(
        (
          await instance.inject({
            method: 'GET',
            url: `/api/rooms${query}`,
            headers: headers(session, false),
          })
        ).statusCode,
        query,
      ).toBe(400);
    await instance.close();
  });
});
