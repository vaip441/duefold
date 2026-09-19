import { createHash, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Clock } from '@duefold/shared/clock';
import { createCorrelationId, createOpaqueId, createOpaqueSecret } from '@duefold/shared/ids';
import type { CorrelationId } from '@duefold/shared/ids';

export const DEFAULT_IDLE_MINUTES = 30;
export const DEFAULT_ABSOLUTE_HOURS = 12;
export const IDLE_RENEWAL_CADENCE_MINUTES = 5;
export const SESSION_BOUNDS = {
  idleMinutes: { min: 5, max: 60 },
  absoluteHours: { min: 1, max: 24 },
} as const;
export interface SessionPolicy {
  readonly idleMinutes: number;
  readonly absoluteHours: number;
}
export interface Principal {
  readonly kind: 'member' | 'viewer';
  readonly id: string;
  readonly familyId?: string;
  readonly oidcAuthenticatedAt?: Date;
}
export type AuthenticationMethod = 'oidc' | 'otp';
export interface IssuedSession {
  readonly id: string;
  readonly secret: string;
  readonly csrfToken: string;
  readonly familyId: string;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
}
export const SESSION_COOKIE = '__Host-duefold_session';
export const SESSION_COOKIE_OPTIONS = {
  secure: true,
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
};

/**
 * Double-submit CSRF cookie.
 *
 * The session row stores only `csrf_digest`, so the raw token exists exactly
 * once: at issuance. The browser therefore has to hold it, and it holds it in a
 * host-only readable cookie which it echoes in the `x-duefold-csrf` header.
 * `csrfValid` still compares that header against the stored digest, so the
 * server never needs the raw value back.
 *
 * `httpOnly` is deliberately false. A CSRF token is not an XSS control: script
 * running on this origin can already issue any mutation using the HttpOnly
 * session cookie. What the token must resist is a cross-origin READ, which the
 * cookie jar and the absence of CORS headers carry, not `HttpOnly`. The
 * `__Host-` prefix forbids `Domain`, so no sibling subdomain can read it.
 *
 * INVARIANT for whoever wires `rotateSession` into a live route: rotation mints
 * a new CSRF token and a new `csrf_digest`, so it MUST set this cookie in the
 * same reply. A stale cookie would fail later mutations as opaque 403s.
 */
export const CSRF_COOKIE = '__Host-duefold_csrf';
export const CSRF_COOKIE_OPTIONS = {
  secure: true,
  httpOnly: false,
  sameSite: 'lax' as const,
  path: '/',
};

export function validateSessionPolicy(policy: SessionPolicy): SessionPolicy {
  if (
    !Number.isInteger(policy.idleMinutes) ||
    policy.idleMinutes < SESSION_BOUNDS.idleMinutes.min ||
    policy.idleMinutes > SESSION_BOUNDS.idleMinutes.max
  )
    throw new Error('invalid session idle lifetime');
  if (
    !Number.isInteger(policy.absoluteHours) ||
    policy.absoluteHours < SESSION_BOUNDS.absoluteHours.min ||
    policy.absoluteHours > SESSION_BOUNDS.absoluteHours.max
  )
    throw new Error('invalid session absolute lifetime');
  return policy;
}
export function sessionExpiry(
  now: Date,
  policy: SessionPolicy,
): { idleExpiresAt: Date; absoluteExpiresAt: Date } {
  validateSessionPolicy(policy);
  const absoluteExpiresAt = new Date(now.getTime() + policy.absoluteHours * 3_600_000);
  const idleExpiresAt = new Date(
    Math.min(now.getTime() + policy.idleMinutes * 60_000, absoluteExpiresAt.getTime()),
  );
  return { idleExpiresAt, absoluteExpiresAt };
}
export function digestSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface AuthenticationCookie {
  readonly name: string;
  readonly value: string;
  readonly options: {
    readonly secure: boolean;
    readonly httpOnly: boolean;
    readonly sameSite: 'lax';
    readonly path: string;
    readonly expires: Date;
  };
}

/**
 * The only place authentication cookies are described. Both issuance routes use
 * it so the session and CSRF cookies cannot drift apart in expiry or options.
 */
export function authenticationCookies(session: IssuedSession): readonly AuthenticationCookie[] {
  return [
    {
      name: SESSION_COOKIE,
      value: session.secret,
      options: { ...SESSION_COOKIE_OPTIONS, expires: session.absoluteExpiresAt },
    },
    {
      name: CSRF_COOKIE,
      value: session.csrfToken,
      options: { ...CSRF_COOKIE_OPTIONS, expires: session.absoluteExpiresAt },
    },
  ];
}

/** Cleared together on sign-out: a readable CSRF cookie outliving its session serves nothing. */
export const CLEARED_AUTHENTICATION_COOKIES = [
  { name: SESSION_COOKIE, options: SESSION_COOKIE_OPTIONS },
  { name: CSRF_COOKIE, options: CSRF_COOKIE_OPTIONS },
] as const;
export function constantTimeDigestMatch(value: string, storedDigest: string): boolean {
  const actual = Buffer.from(digestSecret(value), 'hex');
  const expected = Buffer.from(storedDigest, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function insertSession(
  client: PoolClient,
  principal: Principal,
  method: AuthenticationMethod,
  clock: Clock,
  policy: SessionPolicy,
  correlationId: CorrelationId,
): Promise<IssuedSession> {
  const id = createOpaqueId();
  const secret = createOpaqueSecret();
  const csrfToken = createOpaqueSecret();
  const familyId = principal.familyId ?? createOpaqueId();
  const now = clock.now();
  const expiry = sessionExpiry(now, policy);
  await client.query(
    `INSERT INTO session (id,secret_digest,csrf_digest,principal_kind,member_id,viewer_id,family_id,oidc_authenticated_at,idle_expires_at,absolute_expires_at,last_seen_at,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
    [
      id,
      digestSecret(secret),
      digestSecret(csrfToken),
      principal.kind,
      principal.kind === 'member' ? principal.id : null,
      principal.kind === 'viewer' ? principal.id : null,
      familyId,
      principal.kind === 'member' ? (principal.oidcAuthenticatedAt ?? null) : null,
      expiry.idleExpiresAt,
      expiry.absoluteExpiresAt,
      now,
    ],
  );
  await client.query(
    `INSERT INTO audit_event (id,event_type,actor_kind,actor_id,subject_id,result,reason_code,correlation_id)
     VALUES ($1,$2,$3,$4,$5,'success','SESSION_ISSUED',$6)`,
    [createOpaqueId(), `auth.${method}`, principal.kind, principal.id, id, correlationId],
  );
  return { id, secret, csrfToken, familyId, ...expiry };
}
export async function issueSession(
  pool: Pool,
  principal: Principal,
  method: AuthenticationMethod,
  clock: Clock,
  policy: SessionPolicy = {
    idleMinutes: DEFAULT_IDLE_MINUTES,
    absoluteHours: DEFAULT_ABSOLUTE_HOURS,
  },
): Promise<IssuedSession> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const session = await insertSession(
      client,
      principal,
      method,
      clock,
      policy,
      createCorrelationId(),
    );
    await client.query('COMMIT');
    return session;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export async function rotateSession(
  pool: Pool,
  oldSecret: string,
  principal: Principal,
  method: AuthenticationMethod,
  clock: Clock,
  policy: SessionPolicy = {
    idleMinutes: DEFAULT_IDLE_MINUTES,
    absoluteHours: DEFAULT_ABSOLUTE_HOURS,
  },
): Promise<IssuedSession> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query<{ family_id: string }>(
      "UPDATE session SET state = 'rotated' WHERE secret_digest = $1 AND state = 'active' RETURNING family_id",
      [digestSecret(oldSecret)],
    );
    if (updated.rowCount !== 1) throw new Error('SESSION_NOT_ACTIVE');
    const familyIdValue: unknown = updated.rows[0]?.family_id;
    if (typeof familyIdValue !== 'string') throw new Error('SESSION_FAMILY_MISSING');
    const session = await insertSession(
      client,
      { ...principal, familyId: familyIdValue },
      method,
      clock,
      policy,
      createCorrelationId(),
    );
    await client.query(
      `INSERT INTO audit_event (id,event_type,actor_kind,actor_id,subject_id,result,reason_code,correlation_id)
       VALUES ($1,'session.revoked',$2,$3,$4,'success','SESSION_ROTATED',$5)`,
      [createOpaqueId(), principal.kind, principal.id, familyIdValue, createCorrelationId()],
    );
    await client.query('COMMIT');
    return session;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export async function revokeSessionFamily(pool: Pool, familyId: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      "UPDATE session SET state = 'revoked' WHERE family_id = $1 AND state = 'active' RETURNING principal_kind",
      [familyId],
    );
    await client.query(
      `INSERT INTO audit_event (id,event_type,actor_kind,subject_id,result,reason_code,correlation_id)
       VALUES ($1,'session.revoked','system',$2,'success','SESSION_FAMILY_REVOKED',$3)`,
      [createOpaqueId(), familyId, createCorrelationId()],
    );
    await client.query('COMMIT');
    return result.rowCount ?? 0;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export async function revokePrincipalSessions(
  pool: Pool,
  principal: Principal,
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const column = principal.kind === 'member' ? 'member_id' : 'viewer_id';
    const result = await client.query(
      `UPDATE session SET state = 'revoked' WHERE ${column} = $1 AND state = 'active'`,
      [principal.id],
    );
    await client.query(
      `INSERT INTO audit_event (id,event_type,actor_kind,actor_id,subject_id,result,reason_code,correlation_id)
       VALUES ($1,'session.revoked',$2,$3,$3,'success','ALL_DEVICES_REVOKED',$4)`,
      [createOpaqueId(), principal.kind, principal.id, createCorrelationId()],
    );
    await client.query('COMMIT');
    return result.rowCount ?? 0;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
