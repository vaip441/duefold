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

export type OidcClientAuthMethod = 'auto' | 'client_secret_post' | 'client_secret_basic';

/**
 * Resolves one token endpoint authentication method from discovery metadata.
 *
 * OIDC Discovery defines `client_secret_basic` as the default when the metadata
 * field is omitted. When both methods are advertised, `client_secret_post` is
 * preferred because it interoperates with Google clients that reject the Basic
 * request encoding produced by oauth4webapi. An explicit operator selection is
 * still checked against metadata; there is no callback-time fallback because an
 * authorization code is single-use.
 */
export function resolveOidcClientAuthMethod(
  advertised: readonly string[] | undefined,
  configured: OidcClientAuthMethod,
): Exclude<OidcClientAuthMethod, 'auto'> {
  const supported = advertised ?? ['client_secret_basic'];
  if (configured !== 'auto') {
    if (!supported.includes(configured)) throw new Error('OIDC_CLIENT_AUTH_METHOD_UNSUPPORTED');
    return configured;
  }
  if (supported.includes('client_secret_post')) return 'client_secret_post';
  if (supported.includes('client_secret_basic')) return 'client_secret_basic';
  throw new Error('OIDC_CLIENT_AUTH_METHOD_UNSUPPORTED');
}

export async function discoverOidc(input: {
  readonly issuer: URL;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly clientAuthMethod?: OidcClientAuthMethod;
}): Promise<oidc.Configuration> {
  const configured = input.clientAuthMethod ?? 'auto';
  const post = oidc.ClientSecretPost(input.clientSecret);
  const basic = oidc.ClientSecretBasic(input.clientSecret);
  const clientAuth: oidc.ClientAuth = (server, client, body, headers) => {
    const method = resolveOidcClientAuthMethod(
      server.token_endpoint_auth_methods_supported,
      configured,
    );
    if (method === 'client_secret_post') post(server, client, body, headers);
    else basic(server, client, body, headers);
  };
  const config = await oidc.discovery(
    input.issuer,
    input.clientId,
    { redirect_uris: [input.redirectUri], response_types: ['code'] },
    clientAuth,
  );
  // Validate compatibility at startup, before accepting a sign-in transaction.
  resolveOidcClientAuthMethod(
    config.serverMetadata().token_endpoint_auth_methods_supported,
    configured,
  );
  return config;
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

/**
 * Exchanges the authorization code and verifies the ID token.
 *
 * openid-client verifies the signature, audience, expiry, state, nonce, and PKCE
 * binding; Duefold's own claim checks then run in `verifiedOidcIdentityFromClaims`.
 *
 * `maxAge` is deliberately NOT passed to the library. Doing so makes oauth4webapi
 * add `auth_time` to the ID token's required claims and reject the token inside the
 * grant call, before any Duefold code sees it. Google never issues `auth_time` even
 * when `max_age` is requested, so every Google sign-in failed there with a library
 * error, which also made the `iat` fallback in `verifiedOidcIdentityFromClaims`
 * unreachable.
 *
 * Freshness is still enforced by that function, against `auth_time` when the
 * provider asserts it and `iat` otherwise, using the same 15-minute window. The
 * authorization request still sends `max_age`, so a provider honouring it continues
 * to re-authenticate a stale session. What is given up is the library's hard
 * requirement that the claim be present, which no Google deployment can satisfy.
 */
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

/**
 * Atomically creates the installation and first verified Owner; it never
 * domain-provisions.
 *
 * The allowlist decision stays here, because the allowlist is deployment
 * configuration rather than database state. Every WRITE is inside
 * `claim_first_owner`, which holds the lock, refuses a second Owner, and audits
 * itself -- so this credential needs no INSERT on `member` (invariant 14).
 */
export async function claimFirstOwner(input: {
  readonly pool: Pool;
  readonly identity: VerifiedOidcIdentity;
  readonly allowlist: readonly string[];
  readonly organizationName: string;
  readonly correlationId: CorrelationId;
}): Promise<FirstOwnerClaim> {
  if (!bootstrapEligible(input.identity, input.allowlist))
    throw new Error('BOOTSTRAP_IDENTITY_NOT_ALLOWED');
  const organizationId = createOpaqueId();
  const memberId = createOpaqueId();
  try {
    await input.pool.query('SELECT claim_first_owner($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
      organizationId,
      input.organizationName,
      memberId,
      input.identity.emailKey,
      input.identity.emailDisplay,
      input.identity.issuer,
      input.identity.subject,
      input.correlationId,
      createOpaqueId(),
    ]);
  } catch (error: unknown) {
    /* A concurrent callback won the lock and claimed the installation. Mapped to the
       name callers already handle rather than surfacing a constraint code. */
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { readonly code?: unknown }).code === '23505'
    )
      throw new Error('OWNER_ALREADY_EXISTS', { cause: error });
    throw error;
  }
  return { memberId, organizationId };
}

/**
 * Resolves an existing active member, or atomically accepts an exact pending
 * invitation.
 *
 * The role a new member receives is NOT decided here. It is read from the invitation
 * inside `accept_member_invitation`, together with that acceptance's audit rows, in
 * one transaction. Choosing the role in this process meant the credential serving the
 * callback could insert an Admin -- or an Owner -- with no invitation behind it, which
 * is why it no longer holds INSERT on `member` at all.
 */
export async function resolveOidcMember(
  pool: Pool,
  identity: VerifiedOidcIdentity,
  correlationId: CorrelationId,
): Promise<{ readonly memberId: string }> {
  const existing = await pool.query<{ id: string }>(
    "SELECT id FROM member WHERE oidc_issuer = $1 AND oidc_subject = $2 AND state = 'active'",
    [identity.issuer, identity.subject],
  );
  const existingId = existing.rows[0]?.id;
  if (existingId !== undefined) return { memberId: existingId };
  const accepted = await pool.query<{ accept_member_invitation: string | null }>(
    'SELECT accept_member_invitation($1,$2,$3,$4,$5,$6,$7,$8)',
    [
      createOpaqueId(),
      identity.emailKey,
      identity.emailDisplay,
      identity.issuer,
      identity.subject,
      correlationId,
      createOpaqueId(),
      createOpaqueId(),
    ],
  );
  const memberId = accepted.rows[0]?.accept_member_invitation ?? null;
  /* NULL rather than an exception, so the callback can distinguish "no invitation" and
     try first-owner bootstrap without the refusal having aborted a transaction. */
  if (memberId === null) throw new Error('MEMBER_INVITATION_REQUIRED');
  return { memberId };
}
