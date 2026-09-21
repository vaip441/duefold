/**
 * The shared fixture for the organization-administration HTTP route suites.
 *
 * These suites run against the real Fastify app, the generated route registry, and real
 * database sessions — not doubles. That is the point: the routes carry no role branch at
 * all, so the only evidence a plain member is refused is that the SECURITY DEFINER
 * function refuses and the error mapping turns SQLSTATE 42501 into a uniform 403. A test
 * against a handler double would prove nothing.
 *
 * WHY THIS IS A MODULE. The route tests were one 1,900-line file sharing a schema, so an
 * ownership transfer in one case and a role change in another reached the next through
 * the database rather than through an argument. Each suite now seeds its own schema
 * (`test/authz/**` runs with `fileParallelism: false`), so a failing case is reproducible
 * on its own.
 *
 * `bulkRooms` is OPT-IN: 200 rooms and three extra members cost real time, and only the
 * page-budget walk needs them.
 */

import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import { FixedClock } from '@duefold/shared/clock';
import { buildTestWebApp, testWebRuntime } from '../../support/web-runtime.ts';
import { createSessionAuthenticator } from '../../../apps/web/src/authenticate.ts';
import { authPool, databasePool, migrationPool, resetSchema } from './database.ts';
import {
  CSRF_COOKIE,
  issueSession,
  SESSION_COOKIE,
  type IssuedSession,
} from '../../../modules/core-security/src/sessions.ts';

const sessionPolicy = { idleMinutes: 30, absoluteHours: 12 };

/** The real app, with the real session authenticator over the real pools. */
export function app(): ReturnType<typeof buildTestWebApp> {
  return buildTestWebApp({
    runtime: testWebRuntime({ pool: databasePool, authPool }),
    authenticate: createSessionAuthenticator(authPool, sessionPolicy),
  });
}

export type TestApp = Awaited<ReturnType<typeof app>>;

/** A real member session. `authenticatedAt` controls OIDC freshness. */
export async function memberSession(
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

/**
 * A real VIEWER session, for the audience guard.
 *
 * Offered here so a route suite does not reach for `issueSession`, `SESSION_COOKIE` and
 * the clock directly: the guard refuses on audience alone, and the only thing a test
 * needs is a cookie header belonging to the wrong audience.
 */
export async function viewerCookie(viewerId: string): Promise<Record<string, string>> {
  const issued = await issueSession(
    authPool,
    { kind: 'viewer', id: viewerId },
    'otp',
    new FixedClock(new Date()),
  );
  return { cookie: `${SESSION_COOKIE}=${issued.secret}` };
}

export function headers(session: IssuedSession, csrf = true): Record<string, string> {
  return {
    cookie: `${SESSION_COOKIE}=${session.secret}; ${CSRF_COOKIE}=${session.csrfToken}`,
    ...(csrf ? { 'x-duefold-csrf': session.csrfToken } : {}),
  };
}

export interface RouteFixture {
  readonly ownerId: string;
  readonly adminId: string;
  readonly plainMemberId: string;
  readonly successorId: string;
  readonly targetMemberId: string;
  readonly viewerId: string;
  readonly roomId: string;
  readonly pendingInvitationId: string;
  /** Empty unless the suite asked for them. */
  readonly bulkRoomIds: readonly string[];
  readonly bulkMemberIds: readonly string[];
}

/* Shared with the administration-function fixture: one declaration of which credential is
   which, so the two cannot drift. */
export {
  authPool,
  bootstrapPool,
  closePools as closeRoutePools,
  currentRevision,
  databasePool,
  migrationPool,
} from './database.ts';

export async function seedRouteFixture(
  options: { readonly bulkRooms?: boolean } = {},
): Promise<RouteFixture> {
  const bulk = options.bulkRooms === true;
  const fixture: RouteFixture = {
    ownerId: createOpaqueId(),
    adminId: createOpaqueId(),
    plainMemberId: createOpaqueId(),
    successorId: createOpaqueId(),
    targetMemberId: createOpaqueId(),
    viewerId: createOpaqueId(),
    roomId: createOpaqueId(),
    pendingInvitationId: createOpaqueId(),
    /*
     * The member list bounds a page by returning fewer SUBJECTS rather than shortening any
     * member's room list, so proving that at the HTTP boundary needs more active
     * assignments than one page's 500-row budget spread across several members. 200 rooms
     * x three members is 600, with each member under the 500-per-member apply bound.
     */
    bulkRoomIds: bulk ? Array.from({ length: 200 }, () => createOpaqueId()) : [],
    bulkMemberIds: bulk ? Array.from({ length: 3 }, () => createOpaqueId()) : [],
  };

  await resetSchema();

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
      [
        fixture.ownerId,
        fixture.adminId,
        fixture.plainMemberId,
        fixture.successorId,
        fixture.targetMemberId,
      ],
    );
    await client.query(
      "INSERT INTO viewer (id,email_key,email_display,session_family_id) VALUES ($1,'route.viewer@example.test','route.viewer@example.test',$2)",
      [fixture.viewerId, createOpaqueId()],
    );
    for (const [index, memberId] of fixture.bulkMemberIds.entries())
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
    fixture.roomId,
    'Route assignment room',
    '',
    fixture.ownerId,
    createOpaqueId(),
    createCorrelationId(),
  ]);
  await databasePool.query('SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)', [
    fixture.pendingInvitationId,
    'route.invited@example.test',
    'Route.Invited@example.test',
    'member',
    fixture.ownerId,
    createOpaqueId(),
    createOpaqueId(),
    createCorrelationId(),
  ]);
  /* Titles are zero-padded so page order and any title-ordered disclosure are
     deterministic rather than dependent on insertion timing. */
  for (const [index, bulkRoomId] of fixture.bulkRoomIds.entries())
    await databasePool.query('SELECT create_room($1,$2,$3,$4,$5,$6)', [
      bulkRoomId,
      `Bulk room ${String(index).padStart(3, '0')}`,
      '',
      fixture.ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);

  return fixture;
}

/**
 * Requests the dry run and returns its server-issued preview.
 *
 * Every legitimate apply goes through this. `transfer_ownership` consumes the preview
 * once and refuses without it, so posting the documented confirmation phrase alone is
 * not sufficient (§9.4).
 */
export async function previewTransfer(
  instance: TestApp,
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

/**
 * Hands ownership back to `ownerId` after a test that moved it.
 *
 * One transaction, demotion first: `one_active_owner` is a non-deferrable partial unique
 * index, so two active Owners may not coexist even for a statement, while
 * `exactly_one_owner_after_member` is deferred to COMMIT and tolerates zero in between.
 */
export async function restoreOwner(ownerId: string, previousOwnerId: string): Promise<void> {
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
