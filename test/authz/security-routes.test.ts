import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { generatedRoutes } from '../../.duefold/generated/routes.ts';
import { generatedMigrations } from '../../.duefold/generated/migrations.ts';
import { generatedJobs } from '../../.duefold/generated/jobs.ts';
import { buildTestWebApp, testWebRuntime } from '../support/web-runtime.ts';
import { createSessionAuthenticator } from '../../apps/web/src/authenticate.ts';
import {
  allMigrationsApplied,
  queuedJobsCompatible,
} from '../../modules/core-security/src/routes/health-ready.ts';
import { migrate } from '../../modules/core-security/src/db/migrate.ts';
import { issueSession } from '../../modules/core-security/src/sessions.ts';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import { FixedClock } from '@duefold/shared/clock';
import { createOtpChallenge } from '../../modules/core-security/src/auth/otp.ts';
import { createHandler as createOtpDeliveryHandler } from '../../modules/core-security/src/jobs/otp-delivery.ts';
import { JobRunner } from '../../apps/worker/src/runner.ts';

async function deliveredCode(challengeId: string, clock: FixedClock): Promise<string> {
  let code: string | undefined;
  const handler = createOtpDeliveryHandler({
    pool: workerPool,
    otpDigestKey: Buffer.alloc(32, 1).toString('base64url'),
    clock,
    mailer: {
      deliver: (message) => {
        if (message.challengeId === challengeId) code = message.code;
        return Promise.resolve();
      },
      close: () => undefined,
    },
  });
  const runner = new JobRunner(workerPool, new Map([['auth.otp.deliver', handler]]));
  for (let index = 0; index < 20 && code === undefined; index += 1) await runner.runOne();
  if (code === undefined) throw new Error('OTP delivery missing');
  return code;
}
const runtime = testWebRuntime();
const unauthenticated = await buildTestWebApp({
  runtime,
  authenticate: () => Promise.resolve(null),
});
const bootstrapPool = new Pool({
  host: '/var/run/postgresql',
  database: 'duefold_test',
});
const migrationPool = new Pool({
  connectionString:
    process.env['DUEFOLD_TEST_MIGRATION_DATABASE_URL'] ??
    'postgresql://duefold_migration:duefold_local_migration@127.0.0.1:5432/duefold_test',
});
const databasePool = new Pool({
  connectionString:
    process.env['DUEFOLD_TEST_DATABASE_URL'] ??
    'postgresql://duefold_runtime:duefold_local_runtime@127.0.0.1:5432/duefold_test',
});
const authPool = new Pool({
  connectionString:
    process.env['DUEFOLD_TEST_AUTH_DATABASE_URL'] ??
    'postgresql://duefold_authenticator:duefold_local_authenticator@127.0.0.1:5432/duefold_test',
});
const workerPool = new Pool({
  connectionString:
    process.env['DUEFOLD_TEST_WORKER_DATABASE_URL'] ??
    'postgresql://duefold_worker:duefold_local_worker@127.0.0.1:5432/duefold_test',
});
const ownerId = createOpaqueId();
const viewerId = createOpaqueId();
const sessionPolicy = { idleMinutes: 30, absoluteHours: 12 };

beforeAll(async () => {
  await bootstrapPool.query(
    'DROP SCHEMA public CASCADE; CREATE SCHEMA public; ALTER SCHEMA public OWNER TO duefold_migration;',
  );
  await migrate(migrationPool, generatedMigrations);
  const client = await migrationPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO member (id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state) VALUES ($1,'owner@example.com','owner@example.com','https://issuer.example','owner','owner','active')",
      [ownerId],
    );
    await client.query("INSERT INTO organization (id,name) VALUES ($1,'Authz')", [
      createOpaqueId(),
    ]);
    await client.query(
      "INSERT INTO viewer (id,email_key,email_display,session_family_id) VALUES ($1,'viewer@example.com','viewer@example.com',$2)",
      [viewerId, createOpaqueId()],
    );
    await migrationPool.query(
      "INSERT INTO invitation (id,kind,email_key,email_display,state,expires_at) VALUES ($1,'viewer','viewer@example.com','viewer@example.com','pending',transaction_timestamp() + interval '7 days')",
      [createOpaqueId()],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});
afterAll(async () => {
  await unauthenticated.close();
  await runtime.pool.end();
  await authPool.end();
  await databasePool.end();
  await workerPool.end();
  await migrationPool.end();
  await bootstrapPool.end();
});

describe('generated route deny-by-default', () => {
  it('denies every registered protected route without authentication', async () => {
    const protectedRoutes = generatedRoutes.filter(({ audience }) => audience !== 'public');
    expect(protectedRoutes.length).toBeGreaterThan(0);
    for (const route of protectedRoutes) {
      const response = await unauthenticated.inject({
        method: route.method,
        url: route.path,
        payload: {},
      });
      expect(response.statusCode, route.id).toBe(401);
    }
  });
});

describe('principal audience and CSRF matrix', () => {
  it.each([
    ['member', '/api/auth/member/sign-out', 403],
    ['viewer', '/api/auth/member/sign-out', 401],
    ['viewer', '/api/auth/viewer/sign-out', 403],
    ['member', '/api/auth/viewer/sign-out', 401],
  ] as const)('%s on %s => %i through a real database session', async (kind, url, status) => {
    const issued = await issueSession(
      authPool,
      { kind, id: kind === 'member' ? ownerId : viewerId },
      kind === 'member' ? 'oidc' : 'otp',
      new FixedClock(new Date()),
    );
    const app = await buildTestWebApp({
      runtime: testWebRuntime({ pool: databasePool, authPool }),
      authenticate: createSessionAuthenticator(authPool, sessionPolicy),
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          payload: {},
          headers: { cookie: `__Host-duefold_session=${issued.secret}` },
        })
      ).statusCode,
    ).toBe(status);
    await app.close();
  });

  it('rejects absent and invalid CSRF and accepts the matching token through the real path', async () => {
    const issued = await issueSession(
      authPool,
      { kind: 'viewer', id: viewerId },
      'otp',
      new FixedClock(new Date()),
    );
    const app = await buildTestWebApp({
      runtime: testWebRuntime({ pool: databasePool, authPool }),
      authenticate: createSessionAuthenticator(authPool, sessionPolicy),
    });
    const request = {
      method: 'POST' as const,
      url: '/api/auth/viewer/sign-out',
      payload: {},
      headers: { cookie: `__Host-duefold_session=${issued.secret}` },
    };
    expect((await app.inject(request)).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          ...request,
          headers: {
            ...request.headers,
            'x-duefold-csrf': 'wrong',
          },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          ...request,
          headers: {
            ...request.headers,
            'x-duefold-csrf': issued.csrfToken,
          },
        })
      ).statusCode,
    ).toBe(204);
    await app.close();
  });

  it('authorizes real database sessions and observes revocation on the next request', async () => {
    const issued = await issueSession(
      authPool,
      { kind: 'viewer', id: viewerId },
      'otp',
      new FixedClock(new Date()),
    );
    const app = await buildTestWebApp({
      runtime: testWebRuntime({ pool: databasePool, authPool }),
      authenticate: createSessionAuthenticator(authPool, sessionPolicy),
    });
    const request = {
      method: 'POST' as const,
      url: '/api/auth/viewer/sign-out-all',
      payload: {},
      headers: {
        cookie: `__Host-duefold_session=${issued.secret}`,
        'x-duefold-csrf': issued.csrfToken,
      },
    };
    expect((await app.inject(request)).statusCode).toBe(204);
    expect((await app.inject(request)).statusCode).toBe(401);
    await app.close();
  });

  it('returns without invoking mail delivery for either eligible or unknown OTP requests', async () => {
    let deliveryCalls = 0;
    const app = await buildTestWebApp({
      runtime: testWebRuntime({
        pool: databasePool,
        authPool,
        deliverOtp: () => {
          deliveryCalls += 1;
          return new Promise<void>(() => undefined);
        },
      }),
      authenticate: () => Promise.resolve(null),
    });
    const eligible = await app.inject({
      method: 'POST',
      url: '/api/auth/otp/request',
      payload: { email: 'viewer@example.com' },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/auth/otp/request',
      payload: { email: 'unknown-latency@example.com' },
    });
    expect(eligible.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(deliveryCalls).toBe(0);
    expect(JSON.parse(eligible.body)).toMatchObject({ accepted: true });
    expect(JSON.parse(unknown.body)).toMatchObject({ accepted: true });
    await app.close();
  });

  it('denies a disabled member through HTTP using a real database session', async () => {
    const memberId = createOpaqueId();
    await migrationPool.query(
      "INSERT INTO member (id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state) VALUES ($1,'http-disabled@example.com','http-disabled@example.com','https://issuer.example','http-disabled','member','active')",
      [memberId],
    );
    const issued = await issueSession(
      authPool,
      { kind: 'member', id: memberId, oidcAuthenticatedAt: new Date() },
      'oidc',
      new FixedClock(new Date()),
    );
    await migrationPool.query("UPDATE member SET state = 'disabled' WHERE id = $1", [memberId]);
    const app = await buildTestWebApp({
      runtime: testWebRuntime({ pool: databasePool, authPool }),
      authenticate: createSessionAuthenticator(authPool, sessionPolicy),
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/member/sign-out',
          payload: {},
          headers: {
            cookie: `__Host-duefold_session=${issued.secret}`,
            'x-duefold-csrf': issued.csrfToken,
          },
        })
      ).statusCode,
    ).toBe(401);
    await app.close();
  });

  it('resolves room-role changes and session-bound OIDC freshness through HTTP', async () => {
    const memberId = createOpaqueId();
    const roomId = createOpaqueId();
    await migrationPool.query(
      "INSERT INTO member (id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state) VALUES ($1,'http-role@example.com','http-role@example.com','https://issuer.example','http-role','member','active')",
      [memberId],
    );
    await databasePool.query('SELECT create_room($1,$2,$3,$4,$5,$6)', [
      roomId,
      'Role test room',
      '',
      ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    /* Seeded and changed on the migration credential: migration 017 revoked direct
     * room_assignment DML from the runtime credential, so a room privilege is now
     * written only by apply_room_assignments or by schema authority. The behaviour
     * under test is unchanged -- the authenticator resolves whatever rows exist. */
    await migrationPool.query(
      "INSERT INTO room_assignment (id,room_id,member_id,room_role) VALUES ($1,$2,$3,'manager')",
      [createOpaqueId(), roomId, memberId],
    );
    const loginAt = new Date();
    const staleAt = new Date(loginAt.getTime() - 30 * 60_000);
    const staleSession = await issueSession(
      authPool,
      { kind: 'member', id: memberId, oidcAuthenticatedAt: staleAt },
      'oidc',
      new FixedClock(loginAt),
    );
    const realAuthenticate = createSessionAuthenticator(authPool, sessionPolicy);
    const observed: Awaited<ReturnType<typeof realAuthenticate>>[] = [];
    const app = await buildTestWebApp({
      runtime: testWebRuntime({ pool: databasePool, authPool }),
      authenticate: async (request) => {
        const session = await realAuthenticate(request);
        observed.push(session);
        return session;
      },
    });
    const request = (secret: string) => ({
      method: 'POST' as const,
      url: '/api/auth/member/sign-out',
      payload: {},
      headers: { cookie: `__Host-duefold_session=${secret}` },
    });
    expect((await app.inject(request(staleSession.secret))).statusCode).toBe(403);
    expect(observed.at(-1)).toMatchObject({
      principal: {
        kind: 'member',
        oidcAuthenticatedAt: staleAt,
        roomRoles: { [roomId]: 'manager' },
      },
    });
    await migrationPool.query(
      "UPDATE room_assignment SET room_role = 'contributor' WHERE room_id = $1 AND member_id = $2",
      [roomId, memberId],
    );
    const freshSession = await issueSession(
      authPool,
      { kind: 'member', id: memberId, oidcAuthenticatedAt: loginAt },
      'oidc',
      new FixedClock(loginAt),
    );
    expect((await app.inject(request(freshSession.secret))).statusCode).toBe(403);
    expect(observed.at(-1)).toMatchObject({
      principal: {
        kind: 'member',
        oidcAuthenticatedAt: loginAt,
        roomRoles: { [roomId]: 'contributor' },
      },
    });
    await app.close();
  });

  it('issues the host-only secure session cookie after OTP verification', async () => {
    const clock = new FixedClock(new Date());
    const digestKey = Buffer.alloc(32, 1).toString('base64url');
    const challenge = await createOtpChallenge({
      pool: authPool,
      email: 'viewer@example.com',
      normalizedIp: '192.0.2.50',
      digestKey,
      networkKey: Buffer.alloc(32, 2).toString('base64url'),
      client: { browser: 'other', os: 'other', device: 'other' },
      clock,
    });
    const localRuntime = testWebRuntime({
      pool: databasePool,
      authPool,
      clock,
      otpDigestKey: digestKey,
    });
    const app = await buildTestWebApp({
      runtime: localRuntime,
      authenticate: () => Promise.resolve(null),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/otp/verify',
      payload: { challengeId: challenge.id, code: await deliveredCode(challenge.id, clock) },
    });
    expect(response.statusCode).toBe(200);
    // Two cookies are set: the HttpOnly session secret and the readable
    // double-submit CSRF token. Each is asserted on its own directives.
    const raw = response.headers['set-cookie'];
    const cookies = Array.isArray(raw) ? raw.map(String) : [String(raw)];
    const session = cookies.find((value) => value.startsWith('__Host-duefold_session='));
    const csrf = cookies.find((value) => value.startsWith('__Host-duefold_csrf='));
    expect(session).toBeDefined();
    expect(session).toContain('Path=/');
    expect(session).toContain('HttpOnly');
    expect(session).toContain('Secure');
    expect(session).toContain('SameSite=Lax');
    expect(session).not.toContain('Domain=');
    // The CSRF cookie must be readable by same-origin script so the client can
    // echo it; it is host-only and Secure like the session cookie.
    expect(csrf).toBeDefined();
    expect(csrf).toContain('Path=/');
    expect(csrf).not.toContain('HttpOnly');
    expect(csrf).toContain('Secure');
    expect(csrf).toContain('SameSite=Lax');
    expect(csrf).not.toContain('Domain=');
    // The response body carries no token: it lives only in the cookie.
    expect(JSON.parse(response.body)).toStrictEqual({ authenticated: true });
    await app.close();
  });

  it('checks the complete generated migration registry and active queued job types', async () => {
    await expect(allMigrationsApplied(databasePool, generatedMigrations)).resolves.toBe(true);
    await expect(
      queuedJobsCompatible(
        databasePool,
        generatedJobs.map(({ id }) => id),
      ),
    ).resolves.toBe(true);

    const removedMigration = [...generatedMigrations]
      .sort((left, right) => left.id.localeCompare(right.id))
      .at(-1);
    if (removedMigration === undefined)
      throw new Error('generated migration registry is empty');
    const removedLedger = (
      await migrationPool.query<{ id: string; checksum: string }>(
        'DELETE FROM duefold_migration WHERE id=$1 RETURNING id,checksum',
        [removedMigration.id],
      )
    ).rows[0];
    if (removedLedger === undefined) throw new Error('migration ledger entry is missing');
    try {
      await expect(allMigrationsApplied(databasePool, generatedMigrations)).resolves.toBe(
        false,
      );
    } finally {
      await migrationPool.query('INSERT INTO duefold_migration(id,checksum) VALUES($1,$2)', [
        removedLedger.id,
        removedLedger.checksum,
      ]);
    }

    const incompatibleJobId = createOpaqueId();
    await migrationPool.query(
      `INSERT INTO job_queue(id,job_type,idempotency_key,payload,state)
       VALUES($1,'uncomposed.job',$2,'{}'::jsonb,'pending')`,
      [incompatibleJobId, createOpaqueId()],
    );
    try {
      await expect(
        queuedJobsCompatible(
          databasePool,
          generatedJobs.map(({ id }) => id),
        ),
      ).resolves.toBe(false);
    } finally {
      await migrationPool.query('DELETE FROM job_queue WHERE id=$1', [incompatibleJobId]);
    }
  });

  it('reports readiness with 200 only when every required dependency is healthy', async () => {
    const healthy = await buildTestWebApp({
      runtime: testWebRuntime({ pool: databasePool }),
      authenticate: () => Promise.resolve(null),
      readiness: {
        database: databasePool,
        extensions: [
          { name: 'storage', check: () => Promise.resolve({ healthy: true, code: 'ok' }) },
          { name: 'scanner', check: () => Promise.resolve({ healthy: true, code: 'ok' }) },
        ],
        manifestConsistent: () => true,
        migrationsApplied: () => Promise.resolve(true),
        jobsCompatible: () => Promise.resolve(true),
      },
    });
    const ready = await healthy.inject({ method: 'GET', url: '/api/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: 'ready', checks: { postgresql: 'ok' } });
    await healthy.close();

    const unhealthy = await buildTestWebApp({
      runtime: testWebRuntime({ pool: databasePool }),
      authenticate: () => Promise.resolve(null),
      readiness: {
        database: databasePool,
        extensions: [
          {
            name: 'storage',
            check: () => Promise.resolve({ healthy: false, code: 'unavailable' }),
          },
          { name: 'scanner', check: () => Promise.resolve({ healthy: true, code: 'ok' }) },
        ],
        manifestConsistent: () => true,
        migrationsApplied: () => Promise.resolve(true),
        jobsCompatible: () => Promise.resolve(true),
      },
    });
    const unready = await unhealthy.inject({ method: 'GET', url: '/api/health/ready' });
    expect(unready.statusCode).toBe(503);
    expect(unready.json()).toMatchObject({
      status: 'unready',
      checks: { postgresql: 'ok', storage: 'unavailable' },
    });
    await unhealthy.close();
  });

  it('reports migration and job incompatibility instead of claiming readiness', async () => {
    const incompatible = await buildTestWebApp({
      runtime: testWebRuntime({ pool: databasePool }),
      authenticate: () => Promise.resolve(null),
      readiness: {
        database: databasePool,
        extensions: [
          { name: 'storage', check: () => Promise.resolve({ healthy: true, code: 'ok' }) },
          { name: 'scanner', check: () => Promise.resolve({ healthy: true, code: 'ok' }) },
        ],
        manifestConsistent: () => true,
        migrationsApplied: () => Promise.resolve(false),
        jobsCompatible: () => Promise.resolve(false),
      },
    });
    const response = await incompatible.inject({ method: 'GET', url: '/api/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'unready',
      checks: { migrations: 'incomplete', jobs: 'incompatible' },
    });
    await incompatible.close();
  });

  it('allows only the configured upload origin in connect-src', async () => {
    const uploadOrigin = 'https://duefold.account.r2.cloudflarestorage.com';
    const app = await buildTestWebApp({
      runtime,
      authenticate: () => Promise.resolve(null),
      uploadOrigin,
    });
    const response = await app.inject({ method: 'GET', url: '/api/health/live' });
    const policy = response.headers['content-security-policy'];
    expect(policy).toContain(`connect-src 'self' ${uploadOrigin}`);
    expect(policy).not.toContain('*.r2.cloudflarestorage.com');
    await app.close();
  });

  it('sets strict security and no-store headers', async () => {
    const response = await unauthenticated.inject({ method: 'GET', url: '/api/health/live' });
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['content-security-policy']).toContain("script-src 'self'");
    expect(response.headers['content-security-policy']).toContain("connect-src 'self'");
    expect(response.headers['content-security-policy']).not.toContain('cloudflarestorage.com');
    expect(response.headers['content-security-policy']).not.toContain("'unsafe-inline'");
  });
});
