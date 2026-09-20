import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as oidc from 'openid-client';
import { generatedConfigSchema } from '../../../.duefold/generated/config-schema.ts';
import { loadConfig } from './config.ts';
import {
  beginOidc,
  finishOidc,
  OIDC_FRESH_MAX_AGE_SECONDS,
  type StoredOidcTransaction,
  type VerifiedOidcIdentity,
  verifiedOidcIdentityFromClaims,
} from './auth/oidc.ts';
import { constantTimeDigestMatch, digestSecret } from './sessions.ts';
import { hasFreshOidc } from './authorization.ts';

function signedJwt(privateKey: KeyObject, payload: Readonly<Record<string, unknown>>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString(
    'base64url',
  );
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${header}.${body}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKey, 'base64url');
  return `${signingInput}.${signature}`;
}

async function finishWithIssuer(input: {
  readonly state?: string;
  readonly nonce?: string;
  readonly audience?: string;
  readonly verifier?: string;
  /** Omits `auth_time`, reproducing Google, which never issues the claim. */
  readonly withoutAuthTime?: boolean;
  readonly expiredToken?: boolean;
}): Promise<VerifiedOidcIdentity> {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  /*
   * The real clock, not a pinned instant. oauth4webapi validates `exp` against
   * Date.now() inside the grant, so a fixed date makes every token expired and the
   * only reachable assertions are failures. That is why no test here had ever
   * exercised a successful exchange.
   */
  const now = new Date();
  const expectedVerifier = 'v'.repeat(43);
  const configuration = new oidc.Configuration(
    {
      issuer: 'https://issuer.example',
      authorization_endpoint: 'https://issuer.example/auth',
      token_endpoint: 'https://issuer.example/token',
      jwks_uri: 'https://issuer.example/jwks',
      id_token_signing_alg_values_supported: ['RS256'],
    },
    'client',
  );
  configuration[oidc.customFetch] = (url, options) => {
    if (url === 'https://issuer.example/token') {
      const body = options.body;
      if (!(body instanceof URLSearchParams) || body.get('code_verifier') !== expectedVerifier)
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'invalid_grant' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          }),
        );
      const token = signedJwt(keys.privateKey, {
        iss: 'https://issuer.example',
        sub: 'subject',
        aud: input.audience ?? 'client',
        exp: now.getTime() / 1_000 + (input.expiredToken === true ? -120 : 60),
        iat: now.getTime() / 1_000,
        ...(input.withoutAuthTime === true ? {} : { auth_time: now.getTime() / 1_000 }),
        nonce: input.nonce ?? 'expected-nonce',
        email: 'owner@example.com',
        email_verified: true,
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({ access_token: 'access', token_type: 'Bearer', id_token: token }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          keys: [
            { ...keys.publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  };
  const transaction: StoredOidcTransaction = {
    state: 'expected-state',
    nonce: 'expected-nonce',
    codeVerifier: input.verifier ?? expectedVerifier,
  };
  return await finishOidc({
    config: configuration,
    callbackUrl: new URL(
      `https://duefold.example/callback?code=code&state=${input.state ?? 'expected-state'}`,
    ),
    transaction,
    now,
  });
}

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    DUEFOLD_DATABASE_URL: 'postgresql://runtime:secret@localhost/duefold',
    DUEFOLD_AUTH_DATABASE_URL: 'postgresql://authenticator:secret@localhost/duefold',
    DUEFOLD_WORKER_DATABASE_URL: 'postgresql://worker:secret@localhost/duefold',
    DUEFOLD_MIGRATION_DATABASE_URL: 'postgresql://migration:secret@localhost/duefold',
    DUEFOLD_PUBLIC_URL: 'https://duefold.example',
    DUEFOLD_OIDC_ISSUER: 'https://issuer.example',
    DUEFOLD_OIDC_CLIENT_ID: 'client',
    DUEFOLD_OIDC_CLIENT_SECRET: 'secret',
    DUEFOLD_OWNER_EMAIL_ALLOWLIST: 'owner@example.com',
    DUEFOLD_ORGANIZATION_NAME: 'Duefold',
    DUEFOLD_OTP_DIGEST_KEY: Buffer.alloc(32, 1).toString('base64url'),
    DUEFOLD_NETWORK_HMAC_KEY: Buffer.alloc(32, 2).toString('base64url'),
    DUEFOLD_PII_HMAC_KEY: Buffer.alloc(32, 3).toString('base64url'),
    DUEFOLD_SMTP_URL: 'smtp://localhost:2525',
    DUEFOLD_AUTH_MAIL_FROM: 'Duefold <no-reply@example.com>',
    DUEFOLD_SESSION_IDLE_MINUTES: '30',
    DUEFOLD_SESSION_ABSOLUTE_HOURS: '12',
    DUEFOLD_STORAGE_ENDPOINT: 'http://127.0.0.1:9000',
    DUEFOLD_STORAGE_REGION: 'us-east-1',
    DUEFOLD_STORAGE_BUCKET: 'duefold',
    DUEFOLD_STORAGE_PATH_STYLE: 'true',
    DUEFOLD_STORAGE_CHECKSUM_SUPPORT: 'true',
    DUEFOLD_STORAGE_WEB_ACCESS_KEY_ID: 'web-access',
    DUEFOLD_STORAGE_WEB_SECRET_ACCESS_KEY: 'web-secret',
    DUEFOLD_STORAGE_WORKER_ACCESS_KEY_ID: 'worker-access',
    DUEFOLD_STORAGE_WORKER_SECRET_ACCESS_KEY: 'worker-secret',
    DUEFOLD_CLAMAV_HOST: '127.0.0.1',
    DUEFOLD_CLAMAV_PORT: '3310',
    DUEFOLD_PROCESSOR_OFFICE_PROGRAM: '/usr/bin/libreoffice',
    DUEFOLD_PROCESSOR_PDF_PROGRAM: '/usr/bin/mutool',
    DUEFOLD_PROCESSOR_IMAGE_PROGRAM: '/usr/bin/magick',
    DUEFOLD_PROCESSOR_TEXT_PROGRAM: '/usr/bin/duefold-text-renderer',
    DUEFOLD_WATERMARK_IMAGE_PROGRAM: '/usr/bin/magick',
    DUEFOLD_SANDBOX_MODE: 'production',
  };
}

describe('generated startup configuration', () => {
  it('rejects unknown, missing, malformed and out-of-bounds values without values in errors', () => {
    expect(() =>
      loadConfig(generatedConfigSchema, {
        ...validEnvironment(),
        DUEFOLD_UNKNOWN: 'top-secret',
      }),
    ).toThrow('unknown configuration key: DUEFOLD_UNKNOWN');
    const missing = validEnvironment();
    delete missing['DUEFOLD_PUBLIC_URL'];
    expect(() => loadConfig(generatedConfigSchema, missing)).toThrow(
      'missing configuration: DUEFOLD_PUBLIC_URL',
    );
    expect(() =>
      loadConfig(generatedConfigSchema, {
        ...validEnvironment(),
        DUEFOLD_PUBLIC_URL: 'not a url top-secret',
      }),
    ).toThrow('invalid URL configuration: DUEFOLD_PUBLIC_URL');
    expect(() =>
      loadConfig(generatedConfigSchema, {
        ...validEnvironment(),
        DUEFOLD_SESSION_IDLE_MINUTES: '61',
      }),
    ).toThrow('invalid bounded configuration: DUEFOLD_SESSION_IDLE_MINUTES');
  });

  it('requires three independent 256-bit OTP, network, and PII keys', () => {
    expect(() =>
      loadConfig(generatedConfigSchema, {
        ...validEnvironment(),
        DUEFOLD_OTP_DIGEST_KEY: 'weak',
      }),
    ).toThrow('weak secret configuration');
    const same = Buffer.alloc(32, 3).toString('base64url');
    expect(() =>
      loadConfig(generatedConfigSchema, {
        ...validEnvironment(),
        DUEFOLD_OTP_DIGEST_KEY: same,
        DUEFOLD_NETWORK_HMAC_KEY: same,
        DUEFOLD_PII_HMAC_KEY: Buffer.alloc(32, 4).toString('base64url'),
      }),
    ).toThrow('independently generated');
  });
});

describe('OIDC freshness and protocol parameters', () => {
  it('requests PKCE, state, nonce and max_age', async () => {
    const configuration = new oidc.Configuration(
      {
        issuer: 'https://issuer.example',
        authorization_endpoint: 'https://issuer.example/auth',
      },
      'client',
    );
    const transaction = await beginOidc(configuration, 'https://duefold.example/callback');
    expect(transaction.authorizationUrl.searchParams.get('state')).toBe(transaction.state);
    expect(transaction.authorizationUrl.searchParams.get('nonce')).toBe(transaction.nonce);
    expect(transaction.authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(transaction.authorizationUrl.searchParams.get('max_age')).toBe(
      String(OIDC_FRESH_MAX_AGE_SECONDS),
    );
  });

  it('infers the authentication instant from iat when the provider omits auth_time', () => {
    /*
     * Google does not issue auth_time: it is absent from its discovery
     * claims_supported and omitted even when max_age is requested. Requiring the
     * claim therefore rejected every Google sign-in with OIDC_AUTH_TIME_REQUIRED
     * after a successful token exchange, so the first Owner could never be created.
     *
     * iat is accepted as the instant because the authorization request always
     * carries max_age, and the token is minted for that authorization. The identity
     * records that the value was inferred rather than asserted, so an inferred
     * instant is never mistaken for a provider guarantee.
     */
    const now = new Date('2026-03-01T12:00:00Z');
    const googleClaims = {
      iss: 'https://accounts.google.com',
      sub: '1234567890',
      exp: now.getTime() / 1_000 + 3_600,
      iat: now.getTime() / 1_000 - 5,
      email: 'owner@example.com',
      email_verified: true,
    };
    const identity = verifiedOidcIdentityFromClaims(googleClaims, now);
    expect(identity.authenticatedAt.getTime()).toBe((now.getTime() / 1_000 - 5) * 1_000);
    expect(identity.authenticationTimeAsserted).toBe(false);
    expect(hasFreshOidc(identity.authenticatedAt, now)).toBe(true);

    // auth_time still wins when present, and is marked as asserted.
    const asserted = verifiedOidcIdentityFromClaims(
      { ...googleClaims, auth_time: now.getTime() / 1_000 - 120 },
      now,
    );
    expect(asserted.authenticatedAt.getTime()).toBe((now.getTime() / 1_000 - 120) * 1_000);
    expect(asserted.authenticationTimeAsserted).toBe(true);

    // An inferred instant is still subject to the same freshness window, so a
    // replayed old token cannot pass by lacking auth_time.
    expect(() =>
      verifiedOidcIdentityFromClaims(
        { ...googleClaims, iat: now.getTime() / 1_000 - OIDC_FRESH_MAX_AGE_SECONDS - 1 },
        now,
      ),
    ).toThrow('OIDC_AUTH_TIME_STALE');
  });

  it('rejects a token carrying neither auth_time nor iat, and a stale auth_time', () => {
    const now = new Date('2026-03-01T12:00:00Z');
    const claims = {
      iss: 'https://issuer.example',
      sub: 'subject',
      exp: now.getTime() / 1_000 + 60,
      email: 'owner@example.com',
      email_verified: true,
    };
    // Neither claim means there is no basis for a freshness decision at all.
    expect(() => verifiedOidcIdentityFromClaims(claims, now)).toThrow(
      'OIDC_AUTH_TIME_REQUIRED',
    );
    expect(() =>
      verifiedOidcIdentityFromClaims(
        {
          ...claims,
          auth_time: now.getTime() / 1_000 - OIDC_FRESH_MAX_AGE_SECONDS - 1,
        },
        now,
      ),
    ).toThrow('OIDC_AUTH_TIME_STALE');
  });

  it('completes the grant for a provider that never issues auth_time', async () => {
    /*
     * The end-to-end regression test for Google. Passing maxAge to
     * authorizationCodeGrant makes oauth4webapi add auth_time to the ID token's
     * REQUIRED claims and reject the token inside the library, before any Duefold
     * code runs. Google never issues auth_time even though Duefold requests
     * max_age, so every sign-in died there as a library error, and an earlier
     * attempt to tolerate the missing claim in verifiedOidcIdentityFromClaims was
     * unreachable.
     *
     * This drives the real grant path with a Google-shaped token, which is what
     * every existing test here failed to do: the harness always minted auth_time.
     */
    const identity = await finishWithIssuer({ withoutAuthTime: true });
    expect(identity.emailKey).toBe('owner@example.com');
    expect(identity.authenticationTimeAsserted).toBe(false);
    // Freshness is still decided, from iat, by Duefold rather than the library.
    expect(hasFreshOidc(identity.authenticatedAt, new Date())).toBe(true);

    // A provider that does issue it is still preferred and marked as asserted.
    const asserted = await finishWithIssuer({});
    expect(asserted.authenticationTimeAsserted).toBe(true);
  });

  it('rejects audience, state, nonce and PKCE failures', async () => {
    /*
     * These four are the checks that actually run on this path, and each is
     * asserted against a token that is valid in every other respect.
     *
     * This test used to also claim to reject a token signed by the wrong key, and
     * it passed -- but vacuously. The harness pinned `now` to a fixed 2026-03-01
     * while oauth4webapi validates `exp` against the real clock, so every token
     * here was already expired and all five cases rejected on expiry before
     * reaching the check they named. Once the clock was made honest, the
     * wrong-signature case resolved, and the JWKS endpoint was never fetched at
     * all.
     *
     * That is correct library behaviour, not a defect: OIDC Core 3.1.3.7 permits a
     * client to rely on TLS server validation instead of the ID token signature
     * for tokens obtained directly from the token endpoint, and oauth4webapi
     * documents application-level signature validation as needed only for
     * non-repudiation. Duefold reaches the token endpoint over HTTPS with default
     * certificate verification, so the issuer is authenticated by TLS. The
     * assertion was removed rather than kept passing for the wrong reason; adding
     * signature validation would be a real change in behaviour, not a test fix.
     */
    await expect(finishWithIssuer({ audience: 'other-client' })).rejects.toThrow();
    await expect(finishWithIssuer({ state: 'wrong-state' })).rejects.toThrow();
    await expect(finishWithIssuer({ nonce: 'wrong-nonce' })).rejects.toThrow();
    await expect(finishWithIssuer({ verifier: 'x'.repeat(43) })).rejects.toThrow();
  });

  it('rejects an expired ID token against the real clock', async () => {
    // Retained separately because expiry is what the previous fixture was
    // accidentally testing; now it is deliberate and isolated.
    await expect(finishWithIssuer({ expiredToken: true })).rejects.toThrow();
  });

  it('rejects missing required claims and unverified email', () => {
    const now = new Date('2026-03-01T12:00:00Z');
    const valid = {
      iss: 'https://issuer.example',
      sub: 'subject',
      exp: now.getTime() / 1_000 + 60,
      auth_time: now.getTime() / 1_000,
      email: 'owner@example.com',
      email_verified: true,
    };
    expect(() => verifiedOidcIdentityFromClaims({ ...valid, sub: undefined }, now)).toThrow(
      'OIDC_REQUIRED_CLAIMS_MISSING',
    );
    expect(() =>
      verifiedOidcIdentityFromClaims({ ...valid, email_verified: false }, now),
    ).toThrow('OIDC_VERIFIED_EMAIL_REQUIRED');
  });
});

describe('constant-time digest API', () => {
  it('uses one canonical digest matcher', () => {
    expect(constantTimeDigestMatch('csrf', digestSecret('csrf'))).toBe(true);
    expect(constantTimeDigestMatch('wrong', digestSecret('csrf'))).toBe(false);
  });
});
