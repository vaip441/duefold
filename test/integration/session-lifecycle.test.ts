import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyRequest } from 'fastify';
import { createOpaqueId } from '@duefold/shared/ids';
import { FixedClock } from '@duefold/shared/clock';
import { generatedMigrations } from '../../.duefold/generated/migrations.ts';
import { migrate } from '../../modules/core-security/src/db/migrate.ts';
import { issueSession, revokeSession } from '../../modules/core-security/src/sessions.ts';
import { createSessionAuthenticator } from '../../apps/web/src/authenticate.ts';

const bootstrapPool = new Pool({ host: '/var/run/postgresql', database: 'duefold_test' });
const migrationPool = new Pool({
  connectionString: process.env['DUEFOLD_TEST_MIGRATION_DATABASE_URL'],
});
const authPool = new Pool({ connectionString: process.env['DUEFOLD_TEST_AUTH_DATABASE_URL'] });
const viewerId = createOpaqueId();

beforeAll(async () => {
  await bootstrapPool.query(
    'DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE, CREATE ON SCHEMA public TO duefold_migration;',
  );
  await bootstrapPool.query('ALTER SCHEMA public OWNER TO duefold_migration');
  await migrate(migrationPool, generatedMigrations);
  await migrationPool.query(
    "INSERT INTO viewer (id,email_key,email_display,session_family_id) VALUES ($1,'viewer@example.com','viewer@example.com',$2)",
    [viewerId, createOpaqueId()],
  );
});
afterAll(async () => {
  await authPool.end();
  await migrationPool.end();
  await bootstrapPool.end();
});

function sessionRequest(secret: string): FastifyRequest {
  return { cookies: { '__Host-duefold_session': secret } } as unknown as FastifyRequest;
}
/** Moves the session's clock-derived timestamps back, as if `minutes` had passed. */
async function elapse(sessionId: string, minutes: number): Promise<void> {
  await migrationPool.query(
    `UPDATE session SET created_at = created_at - make_interval(mins => $2),
       last_seen_at = last_seen_at - make_interval(mins => $2),
       idle_expires_at = idle_expires_at - make_interval(mins => $2),
       absolute_expires_at = absolute_expires_at - make_interval(mins => $2)
     WHERE id = $1`,
    [sessionId, minutes],
  );
}

describe('session lifecycle', () => {
  it('renews a five-minute idle session before it lapses', async () => {
    const policy = { idleMinutes: 5, absoluteHours: 12 };
    const issued = await issueSession(
      authPool,
      { kind: 'viewer', id: viewerId },
      'otp',
      new FixedClock(new Date()),
      policy,
    );
    const authenticate = createSessionAuthenticator(authPool, policy);
    await elapse(issued.id, 4);
    expect(await authenticate(sessionRequest(issued.secret))).not.toBeNull();
    await elapse(issued.id, 2);
    expect(await authenticate(sessionRequest(issued.secret))).not.toBeNull();
  });

  it('signs out once, and a concurrent second sign-out is a no-op', async () => {
    const principal = { kind: 'viewer', id: viewerId } as const;
    const issued = await issueSession(authPool, principal, 'otp', new FixedClock(new Date()));
    await Promise.all([
      revokeSession(authPool, issued.id, principal),
      revokeSession(authPool, issued.id, principal),
    ]);
    expect(
      (await authPool.query('SELECT state FROM session WHERE id = $1', [issued.id])).rows,
    ).toEqual([{ state: 'revoked' }]);
    expect(
      (
        await migrationPool.query(
          "SELECT actor_kind,actor_id FROM audit_event WHERE event_type = 'session.revoked' AND reason_code = 'SIGN_OUT' AND subject_id = $1",
          [issued.id],
        )
      ).rows,
    ).toEqual([{ actor_kind: 'viewer', actor_id: viewerId }]);
  });
});
