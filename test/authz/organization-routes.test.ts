/**
 * Organization administration route authorization.
 *
 * These run against the real Fastify app, the generated route registry, and real
 * database sessions, not doubles. That is the point: the routes carry no role
 * branch at all, so the only evidence that a plain member is refused is that the
 * SECURITY DEFINER function refuses and the error mapping turns SQLSTATE 42501
 * into a uniform 403. A test against a handler double would prove nothing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { generatedMigrations } from '../../.duefold/generated/migrations.ts';
import { generatedRoutes } from '../../.duefold/generated/routes.ts';
import { buildTestWebApp, testWebRuntime } from '../support/web-runtime.ts';
import { createSessionAuthenticator } from '../../apps/web/src/authenticate.ts';
import { migrate } from '../../modules/core-security/src/db/migrate.ts';
import {
  CSRF_COOKIE,
  issueSession,
  SESSION_COOKIE,
  type IssuedSession,
} from '../../modules/core-security/src/sessions.ts';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import { FixedClock } from '@duefold/shared/clock';

const bootstrapPool = new Pool({
  host: '/var/run/postgresql',
  database: 'duefold_test',
  max: 4,
});
const migrationPool = new Pool({
  connectionString: process.env['DUEFOLD_TEST_MIGRATION_DATABASE_URL'],
  max: 4,
});
const databasePool = new Pool({
  connectionString: process.env['DUEFOLD_TEST_DATABASE_URL'],
  max: 4,
});
const authPool = new Pool({
  connectionString: process.env['DUEFOLD_TEST_AUTH_DATABASE_URL'],
  max: 4,
});
const sessionPolicy = { idleMinutes: 30, absoluteHours: 12 };

const ownerId = createOpaqueId();
const adminId = createOpaqueId();
const plainMemberId = createOpaqueId();
const successorId = createOpaqueId();
const targetMemberId = createOpaqueId();
const viewerId = createOpaqueId();
const roomId = createOpaqueId();
const pendingInvitationId = createOpaqueId();
/**
 * Rooms for the HTTP page-budget walk.
 *
 * The member list bounds a page by returning fewer SUBJECTS rather than shortening any
 * member's room list, so proving that at the HTTP boundary needs more active
 * assignments than one page's 500-row budget spread across several members. 200 rooms
 * x three members is 600, with each member under the 500-per-member apply bound.
 */
const bulkRoomIds = Array.from({ length: 200 }, () => createOpaqueId());
/** Members staffed across every bulk room for that walk. */
const bulkMemberIds = Array.from({ length: 3 }, () => createOpaqueId());

function app() {
  return buildTestWebApp({
    runtime: testWebRuntime({ pool: databasePool, authPool }),
    authenticate: createSessionAuthenticator(authPool, sessionPolicy),
  });
}

/** A real member session. `authenticatedAt` controls OIDC freshness. */
async function memberSession(
  memberId: string,
  authenticatedAt: Date = new Date(),
): Promise<IssuedSession> {
  return issueSession(
    authPool,
    { kind: 'member', id: memberId, oidcAuthenticatedAt: authenticatedAt },
    'oidc',
    new FixedClock(new Date()),
  );
}

function headers(session: IssuedSession, csrf = true): Record<string, string> {
  return {
    cookie: `${SESSION_COOKIE}=${session.secret}; ${CSRF_COOKIE}=${session.csrfToken}`,
    ...(csrf ? { 'x-duefold-csrf': session.csrfToken } : {}),
  };
}

/**
 * Requests the dry run and returns its server-issued preview.
 *
 * Every legitimate apply goes through this. `transfer_ownership` consumes the
 * preview once and refuses without it, so posting the documented confirmation
 * phrase alone is no longer sufficient (§9.4).
 */
async function previewTransfer(
  instance: Awaited<ReturnType<typeof app>>,
  session: IssuedSession,
  memberId: string,
): Promise<{ readonly previewId: string; readonly expectedRevision: number }> {
  const response = await instance.inject({
    method: 'POST',
    url: '/api/members/actions',
    headers: headers(session),
    payload: { action: 'transfer-dry-run', memberId },
  });
  if (response.statusCode !== 200) throw new Error(`preview refused: ${response.statusCode}`);
  const { impact } = response.json<{
    readonly impact: { readonly previewId: string; readonly expectedRevision: number };
  }>();
  return { previewId: impact.previewId, expectedRevision: impact.expectedRevision };
}

async function currentRevision(memberId: string): Promise<number> {
  const revision = (
    await migrationPool.query<{ revision: number }>('SELECT revision FROM member WHERE id=$1', [
      memberId,
    ])
  ).rows[0]?.revision;
  if (revision === undefined) throw new Error('member missing');
  return revision;
}

/**
 * Hands ownership back to `ownerId` after a test that moved it.
 *
 * One transaction, demotion first: `one_active_owner` is a non-deferrable partial
 * unique index, so two active Owners may not coexist even for a statement, while
 * `exactly_one_owner_after_member` is deferred to COMMIT and tolerates zero in
 * between.
 */
async function restoreOwner(previousOwnerId: string): Promise<void> {
  const client = await migrationPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("UPDATE member SET global_role='member' WHERE id=$1", [previousOwnerId]);
    await client.query("UPDATE member SET global_role='owner' WHERE id=$1", [ownerId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  await bootstrapPool.query(
    'DROP SCHEMA public CASCADE; CREATE SCHEMA public; ALTER SCHEMA public OWNER TO duefold_migration;',
  );
  await migrate(migrationPool, generatedMigrations);
  const client = await migrationPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("INSERT INTO organization (id,name) VALUES ($1,'Organization routes')", [
      createOpaqueId(),
    ]);
    await client.query(
      `INSERT INTO member
       (id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state)
       VALUES
       ($1,'route.owner@example.test','Route.Owner@example.test','https://issuer.example','route-owner','owner','active'),
       ($2,'route.admin@example.test','Route.Admin@example.test','https://issuer.example','route-admin','admin','active'),
       ($3,'route.member@example.test','Route.Member@example.test','https://issuer.example','route-member','member','active'),
       ($4,'route.successor@example.test','Route.Successor@example.test','https://issuer.example','route-successor','admin','active'),
       ($5,'route.target@example.test','Route.Target@example.test','https://issuer.example','route-target','member','active')`,
      [ownerId, adminId, plainMemberId, successorId, targetMemberId],
    );
    await client.query(
      "INSERT INTO viewer (id,email_key,email_display,session_family_id) VALUES ($1,'route.viewer@example.test','route.viewer@example.test',$2)",
      [viewerId, createOpaqueId()],
    );
    for (const [index, memberId] of bulkMemberIds.entries())
      await client.query(
        `INSERT INTO member
         (id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state)
         VALUES ($1,$2,$3,'https://issuer.example',$4,'member','active')`,
        [
          memberId,
          `route.bulk${index}@example.test`,
          `Route.Bulk${index}@example.test`,
          `route-bulk-${index}`,
        ],
      );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await databasePool.query('SELECT create_room($1,$2,$3,$4,$5,$6)', [
    roomId,
    'Route assignment room',
    '',
    ownerId,
    createOpaqueId(),
    createCorrelationId(),
  ]);
  await databasePool.query('SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)', [
    pendingInvitationId,
    'route.invited@example.test',
    'Route.Invited@example.test',
    'member',
    ownerId,
    createOpaqueId(),
    createOpaqueId(),
    createCorrelationId(),
  ]);
  /* Titles are zero-padded so page order and any title-ordered disclosure are
   * deterministic rather than dependent on insertion timing. */
  for (const [index, bulkRoomId] of bulkRoomIds.entries())
    await databasePool.query('SELECT create_room($1,$2,$3,$4,$5,$6)', [
      bulkRoomId,
      `Bulk room ${String(index).padStart(3, '0')}`,
      '',
      ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);
});

afterAll(async () => {
  await authPool.end();
  await databasePool.end();
  await migrationPool.end();
  await bootstrapPool.end();
});

describe('member administration route declarations', () => {
  it('declares both routes as member-audience with CSRF only on the mutation', () => {
    const list = generatedRoutes.find(({ id }) => id === 'organization.members.list');
    const actions = generatedRoutes.find(({ id }) => id === 'organization.members.actions');
    expect(list).toMatchObject({
      method: 'GET',
      path: '/api/members',
      audience: 'member',
      csrf: false,
    });
    expect(actions).toMatchObject({
      method: 'POST',
      path: '/api/members/actions',
      audience: 'member',
      csrf: true,
    });
  });

  /*
   * §7 requires response schemas to be validated, and both routes previously declared
   * only success statuses. That left every designed 400/401/403/409/500 reply outside
   * validation, and the uniform non-enumerating 403 body is a privacy control whose
   * shape must not be free to drift.
   *
   * Asserted against the INSTALLED generated schema, not the source module, so a
   * declaration that failed to reach the registry fails here.
   */
  it('declares a validated error envelope for every status either route can emit', () => {
    for (const id of ['organization.members.list', 'organization.members.actions'] as const) {
      const route = generatedRoutes.find((entry) => entry.id === id);
      const responses = (route?.schema as { readonly response: Record<string, unknown> })
        .response;
      for (const status of [400, 401, 403, 409, 500]) {
        const envelope = responses[String(status)] as
          | { readonly properties?: { readonly error?: unknown }; readonly required?: unknown }
          | undefined;
        expect(envelope, `${id} ${status}`).toBeDefined();
        expect(envelope?.properties?.error, `${id} ${status} error property`).toBeDefined();
        expect(
          (envelope as { readonly additionalProperties?: unknown }).additionalProperties,
          `${id} ${status} closed`,
        ).toBe(false);
      }
    }
  });

  /*
   * §23 requires a bound on every growing collection, and assignments grow as
   * members x rooms because rooms have no installation cap. The bound is spent on
   * SUBJECTS: a page returns fewer members rather than fewer rooms for one member, so
   * both bounds are asserted against the INSTALLED schema where a client meets them.
   */
  it('bounds the member page and each subject\u2019s complete assignment set', () => {
    const list = generatedRoutes.find(({ id }) => id === 'organization.members.list');
    const listOk = (list?.schema as { readonly response: Record<string, unknown> }).response[
      '200'
    ] as {
      readonly properties: {
        readonly subjects: {
          readonly maxItems?: number;
          /* A UNION of two kinds. A flat item schema validated each field independently
           * and so admitted records that cannot exist: an `invitation` that was active,
           * held `owner`, and carried assignments, or a `member` that was `pending`. */
          readonly items: {
            readonly anyOf: readonly {
              readonly additionalProperties?: boolean;
              readonly required?: readonly string[];
              readonly properties: Readonly<
                Record<
                  string,
                  {
                    readonly const?: string;
                    readonly maxItems?: number;
                    readonly anyOf?: readonly { readonly const?: string }[];
                  }
                >
              >;
            }[];
          };
        };
      };
      readonly required?: readonly string[];
    };
    expect(listOk.properties.subjects.maxItems).toBe(100);
    const kinds = listOk.properties.subjects.items.anyOf;
    expect(kinds).toHaveLength(2);
    const memberKind = kinds.find((kind) => kind.properties['subjectKind']?.const === 'member');
    const invitationKind = kinds.find(
      (kind) => kind.properties['subjectKind']?.const === 'invitation',
    );
    expect(memberKind).toBeDefined();
    expect(invitationKind).toBeDefined();
    /*
     * EACH BRANCH IS CLOSED. Without this the union would be decorative: an open object
     * admits the other kind's fields alongside its own, so an invitation could still
     * arrive carrying assignments and a member could still carry a bare `intendedRole`.
     */
    expect(memberKind?.additionalProperties).toBe(false);
    expect(invitationKind?.additionalProperties).toBe(false);

    /* A member REQUIRES its role, its state, and its complete assignment set. An absent
     * assignment field would read as "no rooms", which is a claim about access rather
     * than an absence of data. */
    expect(memberKind?.required ?? []).toEqual(
      expect.arrayContaining([
        'subjectKind',
        'subjectId',
        'emailDisplay',
        'revision',
        'createdAt',
        'globalRole',
        'state',
        'assignments',
      ]),
    );
    /* The same number apply_room_assignments enforces per member, which is what lets
     * every returned member carry a COMPLETE set rather than a prefix. */
    expect(memberKind?.properties['assignments']?.maxItems).toBe(500);
    /* A member is active or disabled. `pending` belongs to an invitation, and
     * `member.state='invited'` is unreachable through every code path. */
    expect(
      (memberKind?.properties['state']?.anyOf ?? []).map(({ const: value }) => value),
    ).toEqual(['active', 'disabled']);
    /* The Owner appears in this list, so the member branch admits all three roles. */
    expect(
      (memberKind?.properties['globalRole']?.anyOf ?? []).map(({ const: value }) => value),
    ).toEqual(['owner', 'admin', 'member']);

    /* An invitation REQUIRES exactly `pending`, and nothing else is representable. */
    expect(invitationKind?.required ?? []).toEqual(
      expect.arrayContaining([
        'subjectKind',
        'subjectId',
        'emailDisplay',
        'revision',
        'createdAt',
        'globalRole',
        'state',
      ]),
    );
    expect(invitationKind?.properties['state']?.const).toBe('pending');
    /*
     * `globalRole` IS THE WIRE FIELD FOR AN INVITATION TOO, narrowed to the roles an
     * invitation may NAME. Ownership moves only through the audited transfer, so an
     * invitation promising `owner` would advertise an arrival the server cannot honour.
     * The browser renames it to `intendedRole` in its own model, where presenting a
     * promised role as a held one would be the actual mistake; renaming it here would be
     * a second vocabulary for one field.
     */
    expect(
      (invitationKind?.properties['globalRole']?.anyOf ?? []).map(({ const: value }) => value),
    ).toEqual(['admin', 'member']);
    expect(invitationKind?.properties['intendedRole']).toBeUndefined();
    /* An invitation declares NO assignment property, and its object is closed, so the
     * field cannot appear. An invitation has no member row for a room privilege to
     * reference, and an empty array would still have read as "holds none yet". */
    expect(invitationKind?.properties['assignments']).toBeUndefined();
    /* No truncation flag exists, because there is no truncated response to describe:
     * `nextCursor` is the whole completeness contract. A flag saying "something on
     * this page is short" could not name WHICH member, and a short room list reads as
     * that member's whole access. */
    expect(listOk.required ?? []).not.toContain('assignmentsTruncated');
    expect(
      (listOk.properties as Readonly<Record<string, unknown>>)['assignmentsTruncated'],
    ).toBeUndefined();

    /* The apply response calls its set complete, so it is bounded by refusing an
     * over-large batch rather than by truncating. */
    const actions = generatedRoutes.find(({ id }) => id === 'organization.members.actions');
    const actionsOk = (actions?.schema as { readonly response: Record<string, unknown> })
      .response['200'] as {
      readonly anyOf: readonly {
        readonly properties?: {
          readonly assignments?: { readonly maxItems?: number };
          readonly impact?: {
            readonly properties: Readonly<Record<string, { readonly maxItems?: number }>>;
            readonly required?: readonly string[];
          };
        };
      }[];
    };
    const applyShape = actionsOk.anyOf.find(
      (variant) => variant.properties?.assignments !== undefined,
    );
    expect(applyShape?.properties?.assignments?.maxItems).toBe(500);

    /* The ownership preview names the assignments the promotion will revoke. All three
     * fields are REQUIRED: an absent count would read as "no rooms affected", and an
     * omitted truncation flag would let a short list understate the revocation. */
    const previewShape = actionsOk.anyOf.find(
      (variant) => variant.properties?.impact !== undefined,
    )?.properties?.impact;
    expect(previewShape?.required).toEqual(
      expect.arrayContaining([
        'revokedAssignmentCount',
        'revokedAssignments',
        'revokedAssignmentsTruncated',
      ]),
    );
    expect(previewShape?.properties['revokedAssignments']?.maxItems).toBe(100);
  });
});

describe('GET /api/members', () => {
  it('denies an unauthenticated request', async () => {
    const instance = await app();
    expect((await instance.inject({ method: 'GET', url: '/api/members' })).statusCode).toBe(
      401,
    );
    await instance.close();
  });

  /* A viewer is the wrong audience entirely, so the audience guard refuses before
   * any handler runs and the response cannot differ by installation contents. */
  it('denies a viewer session at the audience guard', async () => {
    const issued = await issueSession(
      authPool,
      { kind: 'viewer', id: viewerId },
      'otp',
      new FixedClock(new Date()),
    );
    const instance = await app();
    expect(
      (
        await instance.inject({
          method: 'GET',
          url: '/api/members',
          headers: { cookie: `${SESSION_COOKIE}=${issued.secret}` },
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
    /* An invited person has no member row until acceptance, so the surface must be
     * able to tell the two apart rather than claiming they already have access. */
    expect(invitation).toMatchObject({
      subjectKind: 'invitation',
      state: 'pending',
      globalRole: 'member',
    });
    /*
     * NO `assignments` PROPERTY AT ALL on an invitation.
     *
     * The response schema is a union of two kinds, so the invitation member of it does
     * not declare the field and `additionalProperties: false` refuses one. An empty array
     * would have been a statement about rooms — "holds none yet" — about someone with no
     * member row for a room privilege to reference.
     */
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

  /*
   * `member.state='invited'` is unreachable through every code path: the
   * authenticator inserts `'active'` on acceptance, the runtime role holds no
   * INSERT on `member` at all, and enforce_state_transition permits no transition
   * into it. The column still admits it, so the reader is asked what it does when
   * the database reports a state this process does not recognize.
   *
   * It fails closed as a fault rather than rendering the row. Substituting a
   * guessed state would show access the server did not describe, and dressing an
   * unexpected disagreement up as a clean refusal would hide a real defect
   * (failure-mapping's inverse property).
   */
  /*
   * §23 forbids unbounded queries and requires keyset pagination for growing
   * collections. The route returned every member, every pending invitation, and every
   * active room assignment in one response, with assignment cardinality growing as
   * members x rooms.
   */
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
    // A full page offers a cursor, so the client knows more may exist.
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
    // Every subject exactly once, in the same order as the single large page.
    expect(walked).toEqual(full.subjects.map(({ subjectId }) => subjectId));
    // The last page offers no cursor, so a client cannot request one that cannot exist.
    expect(cursor).toBeUndefined();
    await instance.close();
  });

  /*
   * The assignment page budget, exercised at the HTTP boundary.
   *
   * Staffed here rather than in the file's own fixture because 600 active assignments
   * change what every page of the member list looks like, and the cursor tests above
   * assert on a collection the budget does not cut. The sessions these assignments
   * revoke belong to the staffed members, not to the acting Admin, so the walks below
   * still authenticate normally.
   */
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

    /*
     * THE FINDING THIS CLOSES. Assignments used to be a second, separately bounded
     * projection, and a page that hit the 500-row bound reported one flag meaning
     * "something here is incomplete" -- with no way to learn which member's room list was
     * short and no bounded route to the rest. A short room list reads as that member's
     * whole access, so the response could make a false access claim.
     *
     * The bound now falls on SUBJECTS. Every member the route returns carries their
     * COMPLETE active assignment set, and a page cut short by the budget says so through
     * `nextCursor` like any other continuation.
     *
     * 600 active assignments over three members, walked through every continuation page,
     * with the completeness of each staffed member asserted wherever they appear.
     */
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
      /* The requested limit exceeds the whole collection, so only the assignment budget
       * can end a page here. */
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
        // Never an empty page while subjects remain, so the walk always progresses.
        expect(body.subjects.length).toBeGreaterThan(0);
        for (const subject of body.subjects) {
          walked.push(subject.subjectId);
          /* Complete, wherever on the walk they land: the full 200 rooms, never the
           * prefix that happened to fit the remaining budget. */
          if (bulkMemberIds.includes(subject.subjectId))
            expect(subject.assignments, subject.subjectId).toHaveLength(bulkRoomIds.length);
        }
        if (body.nextCursor === undefined) break;
        /* A page shorter than the requested limit that still continues: exactly the case
         * a client must not read as the end of the collection. */
        expect(body.subjects.length).toBeLessThan(100);
        cursor = body.nextCursor;
        expect(pages).toBeLessThan(20);
      }
      // More than one page despite a limit larger than the whole collection.
      expect(pages).toBeGreaterThan(1);
      expect(walked).toHaveLength(total);
      expect(new Set(walked).size).toBe(walked.length);
      await instance.close();
    });

    /* The same collection walked one subject at a time. A limit of 1 asks for exactly
     * the members whose own sets are large, so it proves the leading subject is always
     * admitted and the walk cannot stall on an empty page. */
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

  /*
   * A page that exactly fills the limit is not evidence of another page. Emitting a
   * cursor whenever the page was merely FULL meant a collection whose size is an exact
   * multiple of the limit always advertised one more page, and the walk above could
   * not catch it because it only reached its final assertion after fetching that extra
   * empty page. The reader now requests limit + 1 and offers a cursor only when the
   * extra row proves continuation.
   */
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

    /* limit === total, so this page is both exactly full and provably the last.
     * Before the fix this returned a cursor that led to an empty page. */
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

    /* One short of the total still continues, so the absence above is a real decision
     * rather than a cursor that never appears. */
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
    // The remainder is non-empty, so the cursor pointed at real rows, and it ends here.
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
      // Neither the unreadable row nor any other member leaks through the fault.
      expect(response.body).not.toContain('@');
    } finally {
      await instance.close();
      await migrationPool.query('DELETE FROM member WHERE id=$1', [strangeId]);
    }
  });
});

describe('POST /api/members/actions', () => {
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
    /* §8.2's normalization is implemented once in the shared normalizer: the key
     * is trimmed and lowercased while the display spelling is preserved. */
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

  /* A stale expected revision is a conflict the client can resolve by reloading,
   * not a fault and not a denial. */
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

  /*
   * Every schema is closed. An unexpected property, a missing one, and a value
   * outside the literal set are all rejected before any SQL runs, so the
   * database boundary is not the only thing standing between a hostile body and
   * an identity change.
   */
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
      /* previewId is required: apply cannot proceed on the documented phrase alone. */
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

/**
 * The room register the staffing dialog names its rooms from.
 *
 * Asserted here because this is where a short register becomes a FALSE ACCESS CLAIM: the
 * assignment dialog decides what "Not staffed" means from this list, so a prefix presented
 * as the whole set would let a room the administrator never received read as a room the
 * member is not in. Completeness therefore has to be the server's statement, not an
 * inference from how full a page looked.
 */
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
    /* 201 rooms exist, so this page continues and says so with a whole cursor. */
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
      // Never an empty page while rooms remain, so the walk always progresses.
      expect(body.rooms.length).toBeGreaterThan(0);
      walked.push(...body.rooms.map(({ roomId: id }) => id));
      if (body.nextCursor === undefined) break;
      cursor = body.nextCursor;
      expect(pages).toBeLessThan(10);
    }
    /* More than one page, so the bound is actually exercised rather than asserted
       against a collection that fits in one response. */
    expect(pages).toBeGreaterThan(1);
    expect(walked).toHaveLength(bulkRoomIds.length + 1);
    expect(new Set(walked).size).toBe(walked.length);
    for (const bulkRoomId of bulkRoomIds) expect(walked).toContain(bulkRoomId);
    await instance.close();
  });

  /*
   * A PARTIAL CURSOR IS A REFUSED REQUEST, not a server fault.
   *
   * The querystring is a union of "no cursor" and "a whole cursor", so half a key is
   * rejected by validation and answered with the designed 400. The handler previously
   * threw a bare `Error`, which the failure mapping does not recognize as a refusal: the
   * client received HTTP 500, indistinguishable from a crashed request, and the server
   * logged a fault for a malformed request it had correctly rejected.
   */
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
    /* The preview id is the evidence apply must present, so the response carries it
     * and it is an opaque server-issued value, not something a client could guess. */
    expect(preview.previewId).toMatch(/^[A-Za-z0-9_-]{32}$/u);
    /* §4.2 makes promotion to Owner supersede the successor's explicit assignments, so
     * the preview names that loss. The successor here holds none, which must read as
     * "no rooms affected" rather than as an omitted answer. */
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

  /*
   * §9.4 requires the dry run. The confirmation phrase is a documented constant, so
   * an apply that never previewed must be refused by evidence rather than by the
   * client's good manners.
   */
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

    /* An Admin cannot obtain a preview, and presenting the Owner's does not lend
     * them the Owner's authority. */
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

  /*
   * A successor who holds rooms is the case the preview must not stay silent about,
   * and the case where apply must be bound to the exact impact the Owner approved.
   *
   * §4.2 gives the Owner standing Room Manager authority everywhere, so promoting the
   * successor revokes every explicit assignment they hold. `member.revision` does not
   * move when a `room_assignment` row changes, so the revision the preview already
   * carried could not notice an assignment landing in between: the transfer then
   * revoked a set the Owner had never seen. The preview records a digest of the set and
   * `transfer_ownership` re-checks it under the target's row lock, so the mismatch is a
   * 409 rather than a silent difference.
   */
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
      /* The room is NAMED, not counted: "one assignment will be revoked" is not a
       * decision the Owner can make. The title is disclosed because the Owner already
       * holds Room Manager authority in every room. */
      expect(impact.revokedAssignmentCount).toBe(1);
      expect(impact.revokedAssignmentsTruncated).toBe(false);
      expect(impact.revokedAssignments).toEqual([
        { roomId, roomTitle: 'Route assignment room', roomRole: 'manager' },
      ]);

      /* One more room for the same successor, after the Owner read the impact. */
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
      // The revision is untouched, so this apply satisfies every other check.
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
      /* Nothing moved: the Owner is still the Owner and both assignments survive, so
       * the refusal cost the successor no access. */
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

      /* A preview taken after the change describes both rooms and is accepted, so the
       * 409 above is staleness rather than a permanent block. */
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
      /* The promotion revoked exactly the disclosed set, and §15.1 requires the spine to
       * name that privilege change alongside the transfer. */
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
      /* Ownership moved, so it is handed back before the remaining ownership tests,
       * which each assume `ownerId` is the active Owner. */
      await restoreOwner(targetMemberId);
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

  /*
   * WHITESPACE IS A MISMATCH, on the server as well as in the browser.
   *
   * The client compares and submits the untouched string, so a padded phrase reaches this
   * check exactly as typed. The database compares with `IS DISTINCT FROM` and trims
   * nothing, which is what makes the browser's exactness meaningful rather than a
   * courtesy: if either side forgave whitespace, the other's strictness would be
   * unobservable and a deliberate human gate would be repairing its own input.
   *
   * Each case is preceded by its own dry run, because a refused apply leaves the preview
   * consumed or unusable and a shared one would make the later cases prove nothing.
   */
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
      // Ownership did not move, so no near miss was silently accepted.
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

  /*
   * §9.4 requires fresh OIDC for ownership. The refusal is named distinctly from
   * an ordinary denial, because "sign in again" is a true recovery instruction
   * here and a false one everywhere else.
   */
  it('refuses ownership transfer on a stale authentication instant', async () => {
    const stale = await memberSession(ownerId, new Date(Date.now() - 30 * 60_000));
    const instance = await app();
    /* A real preview, so the refusal is provably the stale instant and not the
     * missing dry run. */
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

  /*
   * Last, because it consumes the Owner. The transfer revokes the acting Owner's
   * sessions inside its own transaction, so the response says the session ended
   * and the next request on that cookie is 401 -- the documented outcome of a
   * completed transfer, not a failure the surface should render as an error.
   */
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
