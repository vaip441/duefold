/**
 * Browser-boundary authorization tests.
 *
 * These cover the three server changes the browser client required, each of
 * which touches the trust boundary:
 *   1. `GET /api/auth/session` — hands a live CSRF token's counterpart to a
 *      caller holding a valid session cookie;
 *   2. the double-submit CSRF cookie set at both issuance points and cleared on
 *      sign-out;
 *   3. the neutral OIDC failure redirect and the indistinguishable OTP 429.
 *
 * They run against the real Fastify app and a real database session, not a
 * double, so a regression in the authenticator or the cookie options fails here.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import * as oidc from 'openid-client';
import { createHash } from 'node:crypto';
import { generatedMigrations } from '../../.duefold/generated/migrations.ts';
import { generatedRoutes } from '../../.duefold/generated/routes.ts';
import { buildTestWebApp } from '../support/web-runtime.ts';
import { createSessionAuthenticator } from '../../apps/web/src/authenticate.ts';
import { migrate } from '../../modules/core-security/src/db/migrate.ts';
import {
  CSRF_COOKIE,
  issueSession,
  revokePrincipalSessions,
  SESSION_COOKIE,
} from '../../modules/core-security/src/sessions.ts';
import { createOpaqueId } from '@duefold/shared/ids';
import { FixedClock } from '@duefold/shared/clock';
import { testWebRuntime } from '../support/web-runtime.ts';
import { SIGN_IN_FAILED_PATH } from '../../modules/core-security/src/routes/oidc-callback.ts';

const bootstrapPool = new Pool({
  host: '/var/run/postgresql',
  database: 'duefold_test',
});
const migrationPool = new Pool({
  connectionString: process.env['DUEFOLD_TEST_MIGRATION_DATABASE_URL'],
});
const databasePool = new Pool({ connectionString: process.env['DUEFOLD_TEST_DATABASE_URL'] });
const authPool = new Pool({ connectionString: process.env['DUEFOLD_TEST_AUTH_DATABASE_URL'] });
const sessionPolicy = { idleMinutes: 30, absoluteHours: 12 };
const memberId = createOpaqueId();
const viewerId = createOpaqueId();

function app() {
  return buildTestWebApp({
    runtime: testWebRuntime({ pool: databasePool, authPool }),
    authenticate: createSessionAuthenticator(authPool, sessionPolicy),
  });
}

/** Reads one cookie's directives from a `set-cookie` header collection. */
function setCookie(
  headers: Readonly<Record<string, unknown>>,
  name: string,
): string | undefined {
  const raw = headers['set-cookie'];
  const values = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? [raw] : [];
  return values.find((value) => value.startsWith(`${name}=`));
}

beforeAll(async () => {
  await bootstrapPool.query(
    'DROP SCHEMA public CASCADE; CREATE SCHEMA public; ALTER SCHEMA public OWNER TO duefold_migration;',
  );
  await migrate(migrationPool, generatedMigrations);
  // The schema enforces one organization and exactly one active Owner, so the
  // organization is inserted first, in the same transaction as the owner.
  const client = await migrationPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("INSERT INTO organization (id,name) VALUES ($1,'Browser')", [
      createOpaqueId(),
    ]);
    await client.query(
      "INSERT INTO member (id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state) VALUES ($1,'member@example.com','member@example.com','https://issuer.example','browser-member','owner','active')",
      [memberId],
    );
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
  await authPool.end();
  await databasePool.end();
  await migrationPool.end();
  await bootstrapPool.end();
});

describe('session bootstrap', () => {
  it('reports unauthenticated without a cookie, at 200 rather than 401', async () => {
    const instance = await app();
    const response = await instance.inject({ method: 'GET', url: '/api/auth/session' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toStrictEqual({ authenticated: false });
    await instance.close();
  });

  it('reports the principal kind for a real member session and nothing else', async () => {
    const issued = await issueSession(
      authPool,
      { kind: 'member', id: memberId, oidcAuthenticatedAt: new Date() },
      'oidc',
      new FixedClock(new Date()),
    );
    const instance = await app();
    const response = await instance.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: `${SESSION_COOKIE}=${issued.secret}` },
    });
    expect(response.statusCode).toBe(200);
    /*
     * Exactly three fields, and still nothing that identifies the person: the kind of
     * principal, and whether THIS caller may administer members, which the frame needs
     * to decide whether to offer that destination at all. Not the global role, not an
     * identifier, not anyone else's access. The seeded member is the Owner, so the
     * capability is true.
     */
    expect(JSON.parse(response.body)).toStrictEqual({
      authenticated: true,
      principal: 'member',
      mayAdministerOrganization: true,
    });
    await instance.close();
  });

  it('reports the viewer principal for a viewer session', async () => {
    const issued = await issueSession(
      authPool,
      { kind: 'viewer', id: viewerId },
      'otp',
      new FixedClock(new Date()),
    );
    const instance = await app();
    const response = await instance.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: `${SESSION_COOKIE}=${issued.secret}` },
    });
    /* A viewer is never a member, so the member capability is false without the
       question ever being asked of the member table. */
    expect(JSON.parse(response.body)).toStrictEqual({
      authenticated: true,
      principal: 'viewer',
      mayAdministerOrganization: false,
    });
    await instance.close();
  });

  it('reverts to unauthenticated immediately after revocation', async () => {
    const issued = await issueSession(
      authPool,
      { kind: 'viewer', id: viewerId },
      'otp',
      new FixedClock(new Date()),
    );
    const instance = await app();
    const request = {
      method: 'GET' as const,
      url: '/api/auth/session',
      headers: { cookie: `${SESSION_COOKIE}=${issued.secret}` },
    };
    expect(JSON.parse((await instance.inject(request)).body)).toMatchObject({
      authenticated: true,
    });
    await revokePrincipalSessions(authPool, { kind: 'viewer', id: viewerId });
    const after = await instance.inject(request);
    // A revoked session is indistinguishable from no session at all.
    expect(after.statusCode).toBe(200);
    expect(JSON.parse(after.body)).toStrictEqual({ authenticated: false });
    await instance.close();
  });

  it('never returns a CSRF token in the body', async () => {
    const issued = await issueSession(
      authPool,
      { kind: 'member', id: memberId, oidcAuthenticatedAt: new Date() },
      'oidc',
      new FixedClock(new Date()),
    );
    const instance = await app();
    const response = await instance.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: `${SESSION_COOKIE}=${issued.secret}` },
    });
    expect(response.body).not.toContain(issued.csrfToken);
    expect(response.body).not.toContain('csrf');
    await instance.close();
  });

  it('sets no CORS header, so no third-party page can read it', async () => {
    const issued = await issueSession(
      authPool,
      { kind: 'member', id: memberId, oidcAuthenticatedAt: new Date() },
      'oidc',
      new FixedClock(new Date()),
    );
    const instance = await app();
    const response = await instance.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: {
        cookie: `${SESSION_COOKIE}=${issued.secret}`,
        origin: 'https://attacker.example',
      },
    });
    for (const header of Object.keys(response.headers))
      expect(header.toLowerCase()).not.toContain('access-control-');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    await instance.close();
  });

  it('is a read: it never mutates the session state', async () => {
    const issued = await issueSession(
      authPool,
      { kind: 'member', id: memberId, oidcAuthenticatedAt: new Date() },
      'oidc',
      new FixedClock(new Date()),
    );
    const before = await authPool.query<{ csrf_digest: string; state: string }>(
      'SELECT csrf_digest, state FROM session WHERE id = $1',
      [issued.id],
    );
    const instance = await app();
    await instance.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: `${SESSION_COOKIE}=${issued.secret}` },
    });
    const after = await authPool.query<{ csrf_digest: string; state: string }>(
      'SELECT csrf_digest, state FROM session WHERE id = $1',
      [issued.id],
    );
    // Rotating the digest on bootstrap would break every other open tab.
    expect(after.rows[0]?.csrf_digest).toBe(before.rows[0]?.csrf_digest);
    expect(after.rows[0]?.state).toBe('active');
    await instance.close();
  });

  it('is a public route that discloses nothing when unauthenticated', () => {
    const route = generatedRoutes.find((entry) => entry.id === 'auth.session');
    expect(route?.audience).toBe('public');
    expect(route?.csrf).toBe(false);
  });
});

describe('double-submit CSRF cookie', () => {
  it('is cleared alongside the session cookie on member sign-out', async () => {
    const issued = await issueSession(
      authPool,
      { kind: 'member', id: memberId, oidcAuthenticatedAt: new Date() },
      'oidc',
      new FixedClock(new Date()),
    );
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/auth/member/sign-out',
      payload: {},
      headers: {
        cookie: `${SESSION_COOKIE}=${issued.secret}`,
        'x-duefold-csrf': issued.csrfToken,
      },
    });
    expect(response.statusCode).toBe(204);
    const cleared = setCookie(response.headers, CSRF_COOKIE);
    expect(cleared).toBeDefined();
    expect(cleared).toContain('Expires=Thu, 01 Jan 1970');
    expect(setCookie(response.headers, SESSION_COOKIE)).toContain('Expires=Thu, 01 Jan 1970');
    await instance.close();
  });

  it('is cleared on viewer sign-out-everywhere', async () => {
    const issued = await issueSession(
      authPool,
      { kind: 'viewer', id: viewerId },
      'otp',
      new FixedClock(new Date()),
    );
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/auth/viewer/sign-out-all',
      payload: {},
      headers: {
        cookie: `${SESSION_COOKIE}=${issued.secret}`,
        'x-duefold-csrf': issued.csrfToken,
      },
    });
    expect(response.statusCode).toBe(204);
    expect(setCookie(response.headers, CSRF_COOKIE)).toContain('Expires=Thu, 01 Jan 1970');
    await instance.close();
  });

  it('accepts the matching token and rejects a mismatched one', async () => {
    const issued = await issueSession(
      authPool,
      { kind: 'member', id: memberId, oidcAuthenticatedAt: new Date() },
      'oidc',
      new FixedClock(new Date()),
    );
    const instance = await app();
    const base = {
      method: 'POST' as const,
      url: '/api/auth/member/sign-out',
      payload: {},
    };
    // Mismatched token: rejected even though the session cookie is valid.
    expect(
      (
        await instance.inject({
          ...base,
          headers: {
            cookie: `${SESSION_COOKIE}=${issued.secret}; ${CSRF_COOKIE}=wrong-value`,
            'x-duefold-csrf': 'wrong-value',
          },
        })
      ).statusCode,
    ).toBe(403);
    // Matching token, echoed from the cookie as the browser does.
    expect(
      (
        await instance.inject({
          ...base,
          headers: {
            cookie: `${SESSION_COOKIE}=${issued.secret}; ${CSRF_COOKIE}=${issued.csrfToken}`,
            'x-duefold-csrf': issued.csrfToken,
          },
        })
      ).statusCode,
    ).toBe(204);
    await instance.close();
  });

  it('keeps the session cookie HttpOnly while the CSRF cookie is readable', async () => {
    // The session cookie must never become readable; the CSRF cookie must be,
    // or the browser cannot echo it. Both are host-only and Secure.
    const { SESSION_COOKIE_OPTIONS, CSRF_COOKIE_OPTIONS } =
      await import('../../modules/core-security/src/sessions.ts');
    expect(SESSION_COOKIE_OPTIONS.httpOnly).toBe(true);
    expect(SESSION_COOKIE_OPTIONS.secure).toBe(true);
    expect(SESSION_COOKIE_OPTIONS.sameSite).toBe('lax');
    expect(CSRF_COOKIE_OPTIONS.httpOnly).toBe(false);
    expect(CSRF_COOKIE_OPTIONS.secure).toBe(true);
    expect(CSRF_COOKIE_OPTIONS.sameSite).toBe('lax');
    // `__Host-` forbids a Domain attribute, so no sibling subdomain can read it.
    expect(SESSION_COOKIE.startsWith('__Host-')).toBe(true);
    expect(CSRF_COOKIE.startsWith('__Host-')).toBe(true);
  });
});

describe('OIDC callback failure is one neutral state', () => {
  it('accepts the parameters real providers actually append', async () => {
    /*
     * A redirect target is not an API this server defines, and providers add their
     * own parameters to it. Google appends scope, authuser, prompt, and hd; Entra
     * adds session_state and client_info. This schema rejected unknown properties
     * while the app configures Ajv with removeAdditional: false, so every genuine
     * Google callback was answered 400 by validation before the handler ran and
     * member sign-in could not complete at all. It reached a live deployment
     * because every other test here sends only the parameters the schema names.
     *
     * The expected outcome is the neutral failure redirect, not success: the state
     * was never persisted. What matters is that it is 302 from the handler rather
     * than 400 from validation.
     */
    const instance = await app();
    const google = new URLSearchParams({
      state: 'a'.repeat(32),
      code: '4/0AVMBsJj-authorization-code',
      scope: 'email profile openid https://www.googleapis.com/auth/userinfo.email',
      authuser: '0',
      prompt: 'consent',
      hd: 'example.com',
    });
    const response = await instance.inject({
      method: 'GET',
      url: `/api/auth/oidc/callback?${google.toString()}`,
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers['location']).toBe('/sign-in?state=failed');
    // An unexpected parameter must not be echoed anywhere, having been accepted.
    expect(response.body).not.toContain('example.com');
    expect(String(response.headers['location'])).not.toContain('authuser');
    const entra = new URLSearchParams({
      state: 'b'.repeat(32),
      code: 'entra-authorization-code',
      session_state: '9f8c7b6a-5d4e-3f2a-1b0c-9d8e7f6a5b4c',
      client_info: 'eyJ1aWQiOiJzeW50aGV0aWMifQ',
    });
    const entraResponse = await instance.inject({
      method: 'GET',
      url: `/api/auth/oidc/callback?${entra.toString()}`,
    });
    expect(entraResponse.statusCode).toBe(302);
    expect(entraResponse.headers['location']).toBe('/sign-in?state=failed');
    await instance.close();
  });

  it('redirects an identity-provider denial instead of failing validation', async () => {
    const instance = await app();
    const response = await instance.inject({
      method: 'GET',
      url: '/api/auth/oidc/callback?error=access_denied&error_description=User+refused+consent&state=abcdefghijklmnop',
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers['location']).toBe('/sign-in?state=failed');
    await instance.close();
  });

  it('never reflects the provider error or its description', async () => {
    const instance = await app();
    const response = await instance.inject({
      method: 'GET',
      url: '/api/auth/oidc/callback?error=access_denied&error_description=Leaked+description+text',
    });
    expect(response.headers['location']).toBe('/sign-in?state=failed');
    expect(response.body).not.toContain('Leaked');
    expect(response.body).not.toContain('access_denied');
    expect(String(response.headers['location'])).not.toContain('access_denied');
    await instance.close();
  });

  it('forwards the iss parameter a provider requires on the callback', async () => {
    /*
     * RFC 9207. A provider may advertise
     * `authorization_response_iss_parameter_supported`, and Google does, in which
     * case oauth4webapi REQUIRES `iss` on the authorization response and rejects
     * the exchange with 'response parameter "iss" (issuer) missing'. The handler
     * rebuilds the callback URL from the configured redirect URI, and it used to
     * reattach only `code` and `state`, silently dropping `iss`. Every Google
     * sign-in therefore failed inside the library, surfacing as the neutral
     * refusal with OIDC_EXCHANGE_FAILED and no indication of the cause.
     *
     * Asserted through the real route against a provider that advertises the
     * requirement. The exchange still fails here because the state was never
     * persisted and the token endpoint is unreachable; what this pins is that the
     * reconstructed URL carries `iss`, captured from the handler's own fetch.
     */
    const issuerRequiringIss = new oidc.Configuration(
      {
        issuer: 'https://accounts.google.example',
        authorization_endpoint: 'https://accounts.google.example/authorize',
        token_endpoint: 'https://accounts.google.example/token',
        jwks_uri: 'https://accounts.google.example/jwks',
        authorization_response_iss_parameter_supported: true,
      },
      'client',
    );
    const seen: string[] = [];
    const customFetch = vi.fn((url: string | URL) => {
      seen.push(String(url));
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    issuerRequiringIss[oidc.customFetch] = customFetch;
    const state = 'z'.repeat(32);
    const instance = await buildTestWebApp({
      runtime: testWebRuntime({
        pool: databasePool,
        authPool,
        oidc: issuerRequiringIss,
      }),
      authenticate: createSessionAuthenticator(authPool, sessionPolicy),
    });
    await authPool.query(
      `INSERT INTO oidc_transaction (state_digest, nonce, code_verifier, expires_at)
         VALUES ($1, $2, $3, transaction_timestamp() + interval '10 minutes')`,
      [createHash('sha256').update(state).digest('hex'), 'n'.repeat(32), 'v'.repeat(43)],
    );
    const response = await instance.inject({
      method: 'GET',
      url: `/api/auth/oidc/callback?code=authorization-code&state=${state}&iss=${encodeURIComponent('https://accounts.google.example')}`,
    });
    // Neutral refusal either way; the point is WHY it was refused.
    expect(response.statusCode).toBe(302);
    expect(response.headers['location']).toBe(SIGN_IN_FAILED_PATH);
    // Reaching the token endpoint at all proves the iss check passed. Without the
    // parameter, oauth4webapi rejects before any request is made, so `seen` is
    // empty.
    expect(seen.some((url) => url.includes('/token'))).toBe(true);
    expect(customFetch).toHaveBeenCalledTimes(1);
    await instance.close();
  });

  it('redirects an invalid transaction to the same neutral state', async () => {
    const instance = await app();
    const response = await instance.inject({
      method: 'GET',
      url: '/api/auth/oidc/callback?code=irrelevant&state=never-persisted-state',
    });
    // Indistinguishable from a provider denial: same status, same location.
    expect(response.statusCode).toBe(302);
    expect(response.headers['location']).toBe('/sign-in?state=failed');
    expect(response.body).not.toContain('OIDC_TRANSACTION_INVALID');
    await instance.close();
  });

  it('still rejects a callback carrying neither a code nor a provider error', async () => {
    const instance = await app();
    const response = await instance.inject({
      method: 'GET',
      url: '/api/auth/oidc/callback',
    });
    // Not a user sign-in journey, so it is not given the designed surface.
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toStrictEqual({
      error: { code: 'INTERNAL', message: 'The request could not be completed.' },
    });
    await instance.close();
  });
});

describe('OTP request rate limiting is indistinguishable', () => {
  it('returns a byte-identical 429 for resend cooldown and for the hourly limit', async () => {
    const instance = await app();
    const request = (email: string) => ({
      method: 'POST' as const,
      url: '/api/auth/otp/request',
      payload: { email },
    });
    // First request for this address succeeds neutrally.
    const first = await instance.inject(request('cooldown@example.com'));
    expect(first.statusCode).toBe(202);
    // Immediate second request hits the 60-second resend cooldown.
    const cooldown = await instance.inject(request('cooldown@example.com'));
    expect(cooldown.statusCode).toBe(429);

    // The hourly per-email limit counts rows in the last hour of DATABASE time,
    // so the window is seeded directly rather than by replaying requests: the
    // runtime under test uses a fixed clock that does not advance.
    for (let seeded = 0; seeded < 5; seeded += 1) {
      await authPool.query(
        `INSERT INTO otp_challenge
           (id,email_key,network_period,network_hmac,browser_category,os_category,device_category,created_at)
         VALUES ($1,'hourly@example.com','2026-03',$2,'other','other','other',
                 transaction_timestamp() - ($3 * interval '1 minute'))`,
        [createOpaqueId(), 'f'.repeat(64), seeded + 2],
      );
      // Only one challenge per address may be outstanding, so each seeded row is
      // retired immediately; it still counts toward the hourly window.
      await authPool.query(
        "UPDATE otp_challenge SET state = 'invalidated' WHERE email_key = 'hourly@example.com' AND state = 'awaiting_delivery'",
      );
    }
    const limited = await instance.inject(request('hourly@example.com'));
    expect(limited.statusCode).toBe(429);
    // The two causes must not be separable by status or body.
    expect(limited.body).toBe(cooldown.body);
    expect(JSON.parse(cooldown.body)).toStrictEqual({
      error: { code: 'RATE_LIMITED', message: 'Please wait before trying again.' },
    });
    await instance.close();
  });

  it('keeps the neutral 202 path for an address that is not limited', async () => {
    const instance = await app();
    const eligible = await instance.inject({
      method: 'POST',
      url: '/api/auth/otp/request',
      payload: { email: 'viewer@example.com' },
    });
    const unknown = await instance.inject({
      method: 'POST',
      url: '/api/auth/otp/request',
      payload: { email: 'never-invited@example.com' },
    });
    expect(eligible.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    // Identical but for the opaque challenge id.
    const eligibleBody: unknown = JSON.parse(eligible.body);
    const unknownBody: unknown = JSON.parse(unknown.body);
    expect(eligibleBody).toMatchObject({ accepted: true });
    expect(unknownBody).toMatchObject({ accepted: true });
    expect((eligibleBody as { message: string }).message).toBe(
      (unknownBody as { message: string }).message,
    );
    await instance.close();
  });
});

describe('branding support contact', () => {
  it('is composed as a public route by the optional module', () => {
    const route = generatedRoutes.find((entry) => entry.id === 'branding.support-contact');
    expect(route?.module).toBe('branding-notifications');
    expect(route?.audience).toBe('public');
  });

  it('returns an explicit empty result when unconfigured', async () => {
    const instance = await app();
    const response = await instance.inject({
      method: 'GET',
      url: '/api/branding/support-contact',
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toStrictEqual({ supportContact: null });
    expect(response.headers['cache-control']).toBe('private, no-store');
    await instance.close();
  });

  it('reads the persisted contact identically for every caller and exposes no other branding fields', async () => {
    await migrationPool.query(
      "UPDATE branding_configuration SET support_contact='https://example.com/help',support_contact_kind='url' WHERE singleton",
    );
    const instance = await app();
    const anonymous = await instance.inject({
      method: 'GET',
      url: '/api/branding/support-contact',
    });
    const issued = await issueSession(
      authPool,
      { kind: 'member', id: memberId, oidcAuthenticatedAt: new Date() },
      'oidc',
      new FixedClock(new Date()),
    );
    const authenticated = await instance.inject({
      method: 'GET',
      url: '/api/branding/support-contact',
      headers: { cookie: `${SESSION_COOKIE}=${issued.secret}` },
    });
    expect(anonymous.body).toBe(authenticated.body);
    expect(JSON.parse(anonymous.body)).toStrictEqual({
      supportContact: { kind: 'url', value: 'https://example.com/help' },
    });
    expect(anonymous.body).not.toContain('Duefold');
    await migrationPool.query(
      'UPDATE branding_configuration SET support_contact=NULL,support_contact_kind=NULL WHERE singleton',
    );
    await instance.close();
  });

  it('cannot be supplied by a hostile runtime value because the environment path is absent', () => {
    expect(testWebRuntime()).not.toHaveProperty('supportContact');
  });
});
