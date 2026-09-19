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
  verifiedOidcIdentityFromClaims,
} from './auth/oidc.ts';
import { constantTimeDigestMatch, digestSecret } from './sessions.ts';

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
  readonly signedByWrongKey?: boolean;
}): Promise<void> {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const wrongKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const now = new Date('2026-03-01T12:00:00Z');
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
      const token = signedJwt(
        input.signedByWrongKey === true ? wrongKeys.privateKey : keys.privateKey,
        {
          iss: 'https://issuer.example',
          sub: 'subject',
          aud: input.audience ?? 'client',
          exp: now.getTime() / 1_000 + 60,
          iat: now.getTime() / 1_000,
          auth_time: now.getTime() / 1_000,
          nonce: input.nonce ?? 'expected-nonce',
          email: 'owner@example.com',
          email_verified: true,
        },
      );
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
  await finishOidc({
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

  it('rejects omitted and stale auth_time after verified token processing', () => {
    const now = new Date('2026-03-01T12:00:00Z');
    const claims = {
      iss: 'https://issuer.example',
      sub: 'subject',
      exp: now.getTime() / 1_000 + 60,
      email: 'owner@example.com',
      email_verified: true,
    };
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

  it('rejects signature, audience, state, nonce and PKCE failures', async () => {
    await expect(finishWithIssuer({ signedByWrongKey: true })).rejects.toThrow();
    await expect(finishWithIssuer({ audience: 'other-client' })).rejects.toThrow();
    await expect(finishWithIssuer({ state: 'wrong-state' })).rejects.toThrow();
    await expect(finishWithIssuer({ nonce: 'wrong-nonce' })).rejects.toThrow();
    await expect(finishWithIssuer({ verifier: 'x'.repeat(43) })).rejects.toThrow();
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
