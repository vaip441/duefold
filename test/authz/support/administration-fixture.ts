/**
 * The shared fixture for the organization-administration authorization suites.
 *
 * WHY THIS IS A MODULE. These tests were one 4,100-line file, which meant every case
 * shared one schema, one seeded population, and one accumulating set of side effects.
 * The ownership-transfer cases reseed ownership before each test, the assignment cases
 * staff hundreds of rooms, and role changes supersede assignments -- so a case's
 * starting state depended on which cases had run before it, and a failure could not be
 * reproduced by running that case alone.
 *
 * Each suite now bootstraps its own schema (`test/authz/**` runs with
 * `fileParallelism: false`, so they do not race for the database) and seeds from here.
 * The population and the helpers are stated once; the isolation is per file.
 *
 * `bulkRooms` is OPT-IN. Creating 200 rooms costs about 1.4 seconds, and only the
 * page-budget suites need them, so a suite asks for them rather than paying by default.
 */

import type { Pool } from 'pg';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import { FixedClock } from '@duefold/shared/clock';
import { issueSession } from '../../../modules/core-security/src/sessions.ts';
import { authPool, databasePool, migrationPool, resetSchema } from './database.ts';

/* The credentials and the schema reset are shared with the route fixture; re-exported so a
   suite imports its pools and its population from one place. */
export {
  authPool,
  bootstrapPool,
  closePools as closeAdministrationPools,
  currentRevision,
  databasePool,
  migrationPool,
  workerPool,
} from './database.ts';

/**
 * The seeded population.
 *
 * Every role, and both states of Admin and Member, so an authorization refusal can be
 * shown to depend on the property under test rather than on the only member available.
 */
export interface AdministrationFixture {
  readonly ownerId: string;
  readonly adminId: string;
  readonly disabledAdminId: string;
  readonly plainMemberId: string;
  readonly targetMemberId: string;
  readonly disposableMemberId: string;
  readonly disabledMemberId: string;
  readonly successorId: string;
  readonly secondSuccessorId: string;
  readonly firstRoomId: string;
  readonly secondRoomId: string;
  readonly thirdRoomId: string;
  readonly fourthRoomId: string;
  /** Empty unless the suite asked for them. */
  readonly bulkRoomIds: readonly string[];
}

/**
 * Drops the schema, migrates it, and seeds the population.
 *
 * The member rows and the organization row are inserted in ONE transaction because
 * `exactly_one_owner_after_member` is a deferred constraint trigger checked at commit:
 * an installation with members and no organization, or with no active Owner, is not a
 * state the seed may pass through visibly.
 */
export async function seedAdministrationFixture(
  options: { readonly bulkRooms?: boolean } = {},
): Promise<AdministrationFixture> {
  const fixture: AdministrationFixture = {
    ownerId: createOpaqueId(),
    adminId: createOpaqueId(),
    disabledAdminId: createOpaqueId(),
    plainMemberId: createOpaqueId(),
    targetMemberId: createOpaqueId(),
    disposableMemberId: createOpaqueId(),
    disabledMemberId: createOpaqueId(),
    successorId: createOpaqueId(),
    secondSuccessorId: createOpaqueId(),
    firstRoomId: createOpaqueId(),
    secondRoomId: createOpaqueId(),
    thirdRoomId: createOpaqueId(),
    fourthRoomId: createOpaqueId(),
    /*
     * More than 500 active assignments across several members, so the member list's
     * per-page assignment budget ends a page early and a truncated-vs-complete
     * distinction is observable. 200 rooms let three members hold 600 between them
     * while each stays under the 500-per-member apply bound.
     */
    bulkRoomIds:
      options.bulkRooms === true ? Array.from({ length: 200 }, () => createOpaqueId()) : [],
  };

  await resetSchema();

  const client = await migrationPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO member
       (id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state)
       VALUES
       ($1,'owner@example.test','Owner@example.test','https://issuer.example','owner','owner','active'),
       ($2,'admin@example.test','Admin@example.test','https://issuer.example','admin','admin','active'),
       ($3,'disabled.admin@example.test','Disabled.Admin@example.test','https://issuer.example','disabled-admin','admin','disabled'),
       ($4,'member@example.test','Member@example.test','https://issuer.example','member','member','active'),
       ($5,'target@example.test','Target@example.test','https://issuer.example','target','member','active'),
       ($6,'disposable@example.test','Disposable@example.test','https://issuer.example','disposable','member','active'),
       ($7,'disabled.member@example.test','Disabled.Member@example.test','https://issuer.example','disabled-member','member','disabled'),
       ($8,'successor@example.test','Successor@example.test','https://issuer.example','successor','admin','active'),
       ($9,'second.successor@example.test','Second.Successor@example.test','https://issuer.example','second-successor','member','active')`,
      [
        fixture.ownerId,
        fixture.adminId,
        fixture.disabledAdminId,
        fixture.plainMemberId,
        fixture.targetMemberId,
        fixture.disposableMemberId,
        fixture.disabledMemberId,
        fixture.successorId,
        fixture.secondSuccessorId,
      ],
    );
    await client.query("INSERT INTO organization (id,name) VALUES ($1,'Organization authz')", [
      createOpaqueId(),
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  for (const [roomId, title] of [
    [fixture.firstRoomId, 'First assignment room'],
    [fixture.secondRoomId, 'Second assignment room'],
    [fixture.thirdRoomId, 'Third assignment room'],
    [fixture.fourthRoomId, 'Fourth assignment room'],
  ] as const)
    await databasePool.query('SELECT create_room($1,$2,$3,$4,$5,$6)', [
      roomId,
      title,
      '',
      fixture.ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);
  /* Titles are zero-padded so the ownership preview's (title, room_id) disclosure order
     is deterministic and a test can name the row it expects first. */
  for (const [index, roomId] of fixture.bulkRoomIds.entries())
    await databasePool.query('SELECT create_room($1,$2,$3,$4,$5,$6)', [
      roomId,
      `Bulk room ${String(index).padStart(3, '0')}`,
      '',
      fixture.ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);

  return fixture;
}

export async function activeSessionFor(memberId: string): Promise<string> {
  const issued = await issueSession(
    authPool,
    { kind: 'member', id: memberId, oidcAuthenticatedAt: new Date() },
    'oidc',
    new FixedClock(new Date()),
  );
  return issued.id;
}

export async function sessionState(sessionId: string): Promise<string | undefined> {
  return (
    await migrationPool.query<{ state: string }>('SELECT state FROM session WHERE id=$1', [
      sessionId,
    ])
  ).rows[0]?.state;
}

export async function activeAssignments(
  memberId: string,
): Promise<readonly { readonly room_id: string; readonly room_role: string }[]> {
  return (
    await migrationPool.query<{ room_id: string; room_role: string }>(
      `SELECT room_id,room_role FROM room_assignment
        WHERE member_id=$1 AND state='active' ORDER BY room_id`,
      [memberId],
    )
  ).rows;
}

export async function revokedSessionCount(memberId: string): Promise<number> {
  const count = (
    await migrationPool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM session WHERE member_id=$1 AND state='revoked'",
      [memberId],
    )
  ).rows[0]?.count;
  if (count === undefined) throw new Error('session count unavailable');
  return count;
}

/**
 * Blocks until PostgreSQL reports the given backend as waiting on another transaction.
 *
 * Committing the first transaction before the second has actually reached its lock
 * would test nothing: the second would run afterwards and legitimately succeed, so the
 * contention assertion has to be established rather than assumed from statement order.
 */
export async function waitUntilBlocked(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const blocked = (
      await migrationPool.query<{ blocked: boolean }>(
        'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked',
        [pid],
      )
    ).rows[0]?.blocked;
    if (blocked === true) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error('transaction never blocked');
}

export async function backendPid(client: { query: Pool['query'] }): Promise<number> {
  const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
    ?.pid;
  if (pid === undefined) throw new Error('backend pid unavailable');
  return pid;
}

/**
 * Hands ownership back to the seeded Owner and restores both successors' roles.
 *
 * Every transfer case CONSUMES the current Owner, so each one must start from a known
 * arrangement rather than from whatever the previous case left. One transaction, demotion
 * first: `one_active_owner` is a non-deferrable partial unique index, so two active Owners
 * may not coexist even for a statement, while `exactly_one_owner_after_member` is deferred
 * to COMMIT and tolerates zero in between.
 */
export async function reseedOwnership(fixture: AdministrationFixture): Promise<void> {
  const client = await migrationPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "UPDATE member SET global_role='admin' WHERE global_role='owner' AND id<>$1",
      [fixture.ownerId],
    );
    await client.query("UPDATE member SET global_role='owner',state='active' WHERE id=$1", [
      fixture.ownerId,
    ]);
    await client.query("UPDATE member SET global_role='admin',state='active' WHERE id=$1", [
      fixture.successorId,
    ]);
    await client.query("UPDATE member SET global_role='member',state='active' WHERE id=$1", [
      fixture.secondSuccessorId,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Requests a dry run and returns the server-issued preview.
 *
 * Every legitimate apply goes through this. `transfer_ownership` consumes the preview once
 * and refuses without one, so the documented confirmation phrase alone is not sufficient
 * (§9.4) and a test cannot construct a preview by hand.
 */
export async function issuePreview(input: {
  readonly targetId: string;
  readonly actorId: string;
}): Promise<{
  readonly previewId: string;
  readonly confirmation: string;
  readonly expectedRevision: number;
}> {
  const previewId = createOpaqueId();
  const impact = (
    await databasePool.query<{
      dry_run_ownership_transfer: {
        readonly previewId: string;
        readonly confirmation: string;
        readonly expectedRevision: number;
      };
    }>('SELECT dry_run_ownership_transfer($1,$2,$3)', [
      previewId,
      input.targetId,
      input.actorId,
    ])
  ).rows[0]?.dry_run_ownership_transfer;
  if (impact === undefined) throw new Error('preview missing');
  return {
    previewId: impact.previewId,
    confirmation: impact.confirmation,
    expectedRevision: impact.expectedRevision,
  };
}
