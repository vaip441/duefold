/**
 * `GET /api/status` and `GET /api/status/content` through the real app and real sessions.
 * Neither handler branches on role; every refusal is PostgreSQL's.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOpaqueId } from '@duefold/shared/ids';
import { composedManifest } from '../../.duefold/generated/manifest.ts';
import { generatedMigrations } from '../../.duefold/generated/migrations.ts';
import { generatedRoutes } from '../../.duefold/generated/routes.ts';
import { acknowledgeBackupStatus } from '../../apps/cli/src/lifecycle.ts';
import { applicationVersion } from '../../modules/core-security/src/release.ts';
import { testWebRuntime } from '../support/web-runtime.ts';
import { closePools, migrationPool, workerPool } from './support/database.ts';
import { app, headers, memberSession, viewerCookie } from './support/route-fixture.ts';
import { resetRoomSchema, seedMember, seedRoom, staffRoom } from './support/room-fixture.ts';

let ownerId = '';
let adminId = '';
let plainMemberId = '';
let managerId = '';
let viewerId = '';

beforeAll(async () => {
  ownerId = await resetRoomSchema('Status routes');
  adminId = await seedMember('admin', 'status.routes.admin');
  plainMemberId = await seedMember('member', 'status.routes.plain');
  managerId = await seedMember('member', 'status.routes.manager');
  await staffRoom(managerId, await seedRoom(ownerId, 'Status routes room'), 'manager', ownerId);
  viewerId = createOpaqueId();
  await migrationPool.query(
    'INSERT INTO viewer (id,email_key,email_display,session_family_id) VALUES ($1,$2,$2,$3)',
    [viewerId, 'status.viewer@example.test', createOpaqueId()],
  );
});
afterAll(closePools);

async function read(url: string, memberId: string) {
  const instance = await app();
  const response = await instance.inject({
    method: 'GET',
    url,
    headers: headers(await memberSession(memberId), false),
  });
  await instance.close();
  return response;
}

const PATHS = ['/api/status', '/api/status/content'] as const;

describe('status route declarations', () => {
  it('declares both routes member-audience, without CSRF, with the validated error envelope', () => {
    for (const [id, path] of [
      ['installation.status.read', '/api/status'],
      ['installation.content.read', '/api/status/content'],
    ] as const) {
      const route = generatedRoutes.find((entry) => entry.id === id);
      expect(route).toMatchObject({ method: 'GET', path, audience: 'member', csrf: false });
      const responses = (route?.schema as { readonly response: Record<string, unknown> })
        .response;
      for (const status of [400, 401, 403, 409, 500])
        expect(responses[String(status)], `${id} ${status}`).toBeDefined();
    }
  });
});

describe.each(PATHS)('GET %s', (url) => {
  it('denies an unauthenticated request and a viewer session', async () => {
    const instance = await app();
    expect((await instance.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect(
      (await instance.inject({ method: 'GET', url, headers: await viewerCookie(viewerId) }))
        .statusCode,
    ).toBe(401);
    await instance.close();
  });

  it.each([
    ['plain Member', () => plainMemberId],
    ['Room Manager', () => managerId],
  ])('refuses a %s with the uniform 403', async (_label, actor) => {
    const response = await read(url, actor());
    expect(response.statusCode).toBe(403);
    expect(response.json()).toStrictEqual({
      error: { code: 'FORBIDDEN', message: 'This action is not available to you.' },
    });
  });
});

describe('GET /api/status', () => {
  it.each([
    ['Owner', () => ownerId],
    ['Admin', () => adminId],
  ])('answers %s with the composition this process was built from', async (_label, actor) => {
    const response = await read('/api/status', actor());
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      application: unknown;
      oidc: { readonly discoveryConformedAt: string };
      migrations: unknown;
      checks: readonly { readonly check: string; readonly observation: unknown }[];
    }>();
    expect(body.application).toStrictEqual({
      version: applicationVersion(),
      modules: [...composedManifest.modules],
      adapters: { ...composedManifest.adapters },
    });
    const registry = generatedMigrations.map(({ id }) => id).sort();
    expect(body.migrations).toStrictEqual({
      state: 'current',
      appliedCount: registry.length,
      expectedCount: registry.length,
      latestApplied: registry.at(-1),
    });
    expect(Number.isNaN(Date.parse(body.oidc.discoveryConformedAt))).toBe(false);
    expect(body.checks.map(({ check }) => check)).toStrictEqual([
      'storage-privacy',
      'storage-versioning',
      'scanner',
      'updates',
    ]);
  });

  it('reads an offered release that is now running as current', async () => {
    await migrationPool.query('SELECT record_update_observation($1,$2,$3)', [
      'attention',
      'UPDATE_AVAILABLE',
      applicationVersion(),
    ]);
    const body = (await read('/api/status', ownerId)).json<{
      checks: readonly { readonly check: string; readonly observation: unknown }[];
    }>();
    expect(body.checks.find(({ check }) => check === 'updates')?.observation).toMatchObject({
      result: 'pass',
      code: 'UPDATE_CURRENT',
      evidenceVersion: null,
    });
  });

  it('reports an observation with its evidence and whether it is stale', async () => {
    const built = new Date(Math.floor(Date.now() / 1_000) * 1_000 - 2 * 86_400_000);
    await workerPool.query('SELECT record_worker_status_observation($1,$2,$3,$4)', [
      'scanner',
      'fail',
      'SIGNATURES_STALE',
      built,
    ]);
    const body = (await read('/api/status', ownerId)).json<{
      checks: readonly { readonly check: string; readonly observation: unknown }[];
    }>();
    expect(body.checks.find(({ check }) => check === 'scanner')?.observation).toMatchObject({
      result: 'fail',
      code: 'SIGNATURES_STALE',
      evidenceAt: built.toISOString(),
      evidenceVersion: null,
      stale: false,
    });
  });

  it('carries none of the values this process was configured with', async () => {
    const configured = testWebRuntime();
    const body = (await read('/api/status', ownerId)).body;
    for (const value of [
      process.env['DUEFOLD_TEST_DATABASE_URL'],
      process.env['DUEFOLD_TEST_MIGRATION_DATABASE_URL'],
      configured.oidc.serverMetadata().issuer,
      configured.oidcRedirectUri,
      configured.organizationName,
      configured.otpDigestKey,
      configured.networkHmacKey,
    ])
      if (value !== undefined) expect(body).not.toContain(value);
    expect(body).not.toContain('@');
  });
});

describe('GET /api/status/content', () => {
  it('answers an Owner with the recovery record, as the CLI changes it', async () => {
    expect((await read('/api/status/content', ownerId)).json()).toStrictEqual({
      processing: { failedCount: 0 },
      recovery: {
        backupStatus: 'undetermined',
        backupRetention: null,
        recoveryExpectation: null,
        acknowledgedAt: null,
        restoreDrillStatus: 'not-tested',
        restoreDrillAt: null,
      },
    });
    await acknowledgeBackupStatus(migrationPool, {
      retention: '35 days point-in-time recovery',
      expectation: 'Restore within four hours to the last hour',
    });
    const recovery = (await read('/api/status/content', adminId)).json<{
      recovery: Record<string, unknown>;
    }>().recovery;
    expect(recovery).toMatchObject({
      backupStatus: 'operator-acknowledged',
      backupRetention: '35 days point-in-time recovery',
      recoveryExpectation: 'Restore within four hours to the last hour',
    });
    expect(typeof recovery['acknowledgedAt']).toBe('string');
  });

  it('carries none of the values this process was configured with', async () => {
    const configured = testWebRuntime();
    const body = (await read('/api/status/content', ownerId)).body;
    for (const value of [
      process.env['DUEFOLD_TEST_DATABASE_URL'],
      process.env['DUEFOLD_TEST_MIGRATION_DATABASE_URL'],
      configured.organizationName,
      configured.otpDigestKey,
      configured.networkHmacKey,
    ])
      if (value !== undefined) expect(body).not.toContain(value);
    expect(body).not.toContain('@');
  });
});
