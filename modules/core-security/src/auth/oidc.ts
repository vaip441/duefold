import { createHash } from 'node:crypto';
import * as oidc from 'openid-client';
import type { Pool } from 'pg';
import { normalizeEmail } from '@duefold/shared/email';
import { createOpaqueId } from '@duefold/shared/ids';
import type { CorrelationId } from '@duefold/shared/ids';

export const OIDC_TRANSACTION_SECONDS = 600;
export const OIDC_FRESH_MAX_AGE_SECONDS = 15 * 60;

export interface OidcTransaction {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly authorizationUrl: URL;
}
export interface StoredOidcTransaction {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
}
export interface VerifiedOidcIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly emailKey: string;
  readonly emailDisplay: string;
  readonly authenticatedAt: Date;
  /**
   * Whether `authenticatedAt` is the provider's own `auth_time` assertion rather
   * than a value inferred from `iat`. Carried so an inferred instant is never
   * mistaken for an asserted one; see `verifiedOidcIdentityFromClaims`.
   */
  readonly authenticationTimeAsserted: boolean;
}
export interface FirstOwnerClaim {
  readonly memberId: string;
  readonly organizationId: string;
}

function stateDigest(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}

export async function discoverOidc(input: {
  readonly issuer: URL;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}): Promise<oidc.Configuration> {
  return oidc.discovery(
    input.issuer,
    input.clientId,
    { redirect_uris: [input.redirectUri], response_types: ['code'] },
    oidc.ClientSecretBasic(input.clientSecret),
  );
}

/** Builds a fresh-auth Authorization Code + PKCE request. */
export async function beginOidc(
  config: oidc.Configuration,
  redirectUri: string,
): Promise<OidcTransaction> {
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
  return {
    state,
    nonce,
    codeVerifier,
    authorizationUrl: oidc.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: 'openid email',
      response_type: 'code',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
      max_age: String(OIDC_FRESH_MAX_AGE_SECONDS),
    }),
  };
}

export async function persistOidcTransaction(
  pool: Pool,
  transaction: OidcTransaction,
  now = new Date(),
): Promise<void> {
  await pool.query(
    `INSERT INTO oidc_transaction (state_digest, nonce, code_verifier, expires_at, created_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [
      stateDigest(transaction.state),
      transaction.nonce,
      transaction.codeVerifier,
      new Date(now.getTime() + OIDC_TRANSACTION_SECONDS * 1_000),
      now,
    ],
  );
}

/** Claims state before token exchange. A failed callback cannot be replayed. */
export async function consumeOidcTransaction(
  pool: Pool,
  state: string,
): Promise<StoredOidcTransaction> {
  const result = await pool.query<{ nonce: string; code_verifier: string }>(
    `DELETE FROM oidc_transaction
       WHERE state_digest = $1 AND expires_at > transaction_timestamp()
       RETURNING nonce, code_verifier`,
    [stateDigest(state)],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('OIDC_TRANSACTION_INVALID');
  return { state, nonce: row.nonce, codeVerifier: row.code_verifier };
}

function isClaims(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * Verifies the claims Duefold depends on, after openid-client has verified the
 * signature, audience, expiry, state, nonce, and PKCE binding.
 *
 * `auth_time` is the provider asserting when the user actually authenticated, and
 * `hasFreshOidc` reads it to gate high-consequence actions. Requiring it
 * unconditionally made Google unusable: Google does not list `auth_time` in its
 * discovery `claims_supported` and omits it even when `max_age` is requested, so
 * every sign-in failed with OIDC_AUTH_TIME_REQUIRED after a successful token
 * exchange, and the first Owner could never be created.
 *
 * When `auth_time` is absent, `iat` is used and the identity records that the
 * instant was inferred. This holds for the freshness window because the
 * authorization request always carries `max_age`: a provider honouring it must
 * re-authenticate a session older than that, and the ID token is minted for that
 * authorization, so `iat` tracks the authentication instant within seconds.
 *
 * What is genuinely weaker, and must not be described otherwise: an inferred
 * instant cannot distinguish a real credential re-entry from a silent SSO re-issue.
 * A provider that accepts `max_age` without honouring it would mint a fresh `iat`
 * with no fresh authentication. `auth_time` is therefore still preferred whenever
 * sent, and the difference is recorded rather than flattened away.
 */
export function verifiedOidcIdentityFromClaims(
  claims: unknown,
  now: Date,
): VerifiedOidcIdentity {
  if (
    !isClaims(claims) ||
    typeof claims['iss'] !== 'string' ||
    typeof claims['sub'] !== 'string' ||
    typeof claims['exp'] !== 'number'
  )
    throw new Error('OIDC_REQUIRED_CLAIMS_MISSING');
  if (claims['exp'] * 1_000 <= now.getTime()) throw new Error('OIDC_TOKEN_EXPIRED');
  const authTime = claims['auth_time'];
  const issuedAt = claims['iat'];
  const authenticationTimeAsserted = typeof authTime === 'number';
  // One of the two must be present and numeric. With neither there is no basis for
  // a freshness decision at all, so this still fails closed.
  const authenticationSeconds = authenticationTimeAsserted
    ? authTime
    : typeof issuedAt === 'number'
      ? issuedAt
      : undefined;
  if (authenticationSeconds === undefined) throw new Error('OIDC_AUTH_TIME_REQUIRED');
  const authenticatedAt = new Date(authenticationSeconds * 1_000);
  if (
    authenticatedAt.getTime() > now.getTime() + 60_000 ||
    now.getTime() - authenticatedAt.getTime() > OIDC_FRESH_MAX_AGE_SECONDS * 1_000
  )
    throw new Error('OIDC_AUTH_TIME_STALE');
  const email = claims['email'];
  if (typeof email !== 'string' || claims['email_verified'] !== true)
    throw new Error('OIDC_VERIFIED_EMAIL_REQUIRED');
  const normalizedEmail = normalizeEmail(email);
  return {
    issuer: claims['iss'],
    subject: claims['sub'],
    emailKey: normalizedEmail.comparisonKey,
    emailDisplay: normalizedEmail.display,
    authenticatedAt,
    authenticationTimeAsserted,
  };
}

/** openid-client verifies signature, audience, expiry, state, nonce and PKCE. */
export async function finishOidc(input: {
  readonly config: oidc.Configuration;
  readonly callbackUrl: URL;
  readonly transaction: StoredOidcTransaction;
  readonly now?: Date;
}): Promise<VerifiedOidcIdentity> {
  const tokens = await oidc.authorizationCodeGrant(input.config, input.callbackUrl, {
    expectedState: input.transaction.state,
    expectedNonce: input.transaction.nonce,
    pkceCodeVerifier: input.transaction.codeVerifier,
    idTokenExpected: true,
    maxAge: OIDC_FRESH_MAX_AGE_SECONDS,
  });
  return verifiedOidcIdentityFromClaims(tokens.claims(), input.now ?? new Date());
}

export function bootstrapEligible(
  identity: VerifiedOidcIdentity,
  allowlist: readonly string[],
): boolean {
  const allowed = new Set(allowlist.map((email) => normalizeEmail(email).comparisonKey));
  return allowed.has(identity.emailKey);
}

/** Atomically creates the installation and first verified Owner; it never domain-provisions. */
export async function claimFirstOwner(input: {
  readonly pool: Pool;
  readonly identity: VerifiedOidcIdentity;
  readonly allowlist: readonly string[];
  readonly organizationName: string;
  readonly correlationId: CorrelationId;
}): Promise<FirstOwnerClaim> {
  if (!bootstrapEligible(input.identity, input.allowlist))
    throw new Error('BOOTSTRAP_IDENTITY_NOT_ALLOWED');
  const client = await input.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE organization, member IN EXCLUSIVE MODE');
    const existing = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM member WHERE global_role = 'owner' AND state = 'active'",
    );
    if (existing.rows[0]?.count !== '0') throw new Error('OWNER_ALREADY_EXISTS');
    const organizationId = createOpaqueId();
    const memberId = createOpaqueId();
    await client.query('INSERT INTO organization (id, name) VALUES ($1, $2)', [
      organizationId,
      input.organizationName,
    ]);
    await client.query(
      "INSERT INTO member (id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state) VALUES ($1,$2,$3,$4,$5,'owner','active')",
      [
        memberId,
        input.identity.emailKey,
        input.identity.emailDisplay,
        input.identity.issuer,
        input.identity.subject,
      ],
    );
    await client.query(
      "INSERT INTO audit_event (id,event_type,actor_kind,actor_id,subject_id,result,reason_code,correlation_id) VALUES ($1,'auth.oidc','member',$2,$2,'success','FIRST_OWNER_BOOTSTRAP',$3)",
      [createOpaqueId(), memberId, input.correlationId],
    );
    await client.query('COMMIT');
    return { memberId, organizationId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Resolves an existing active member or atomically accepts an exact pending invitation. */
export async function resolveOidcMember(
  pool: Pool,
  identity: VerifiedOidcIdentity,
): Promise<{ readonly memberId: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM member WHERE oidc_issuer = $1 AND oidc_subject = $2 AND state = 'active' FOR UPDATE",
      [identity.issuer, identity.subject],
    );
    const existingId = existing.rows[0]?.id;
    if (existingId !== undefined) {
      await client.query('COMMIT');
      return { memberId: existingId };
    }
    const invitation = await client.query<{ id: string }>(
      `SELECT id FROM invitation WHERE kind = 'member' AND email_key = $1
         AND state = 'pending' AND expires_at > transaction_timestamp() FOR UPDATE`,
      [identity.emailKey],
    );
    const invitationId = invitation.rows[0]?.id;
    if (invitationId === undefined) throw new Error('MEMBER_INVITATION_REQUIRED');
    const memberId = createOpaqueId();
    await client.query(
      `INSERT INTO member
       (id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state)
       VALUES ($1,$2,$3,$4,$5,'member','active')`,
      [memberId, identity.emailKey, identity.emailDisplay, identity.issuer, identity.subject],
    );
    await client.query("UPDATE invitation SET state = 'accepted' WHERE id = $1", [
      invitationId,
    ]);
    await client.query('COMMIT');
    return { memberId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
