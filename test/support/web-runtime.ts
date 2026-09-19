import * as oidc from 'openid-client';
import { Pool } from 'pg';
import { buildWebApp, type WebDependencies } from '../../apps/web/src/app.ts';
import type { WebRuntime } from '../../apps/web/src/runtime.ts';
import type { ReadinessDependencies } from '../../modules/core-security/src/routes/health-ready.ts';
import { FixedClock } from '@duefold/shared/clock';
import type {
  WebStorage,
  DeliveryStorage,
} from '../../modules/rooms-documents/src/storage/s3-compatible.ts';
import { sandboxProgram } from '../../modules/rooms-documents/src/processing/sandbox.ts';

const unusedStorage: WebStorage = {
  checksumSupport: false,
  checkReady: () => Promise.reject(new Error('unused storage')),
  createMultipart: () => Promise.reject(new Error('unused storage')),
  presignPart: () => Promise.reject(new Error('unused storage')),
  completeMultipart: () => Promise.reject(new Error('unused storage')),
  abortMultipart: () => Promise.reject(new Error('unused storage')),
  headObject: () => Promise.reject(new Error('unused storage')),
  deleteObject: () => Promise.reject(new Error('unused storage')),
};

const unusedDeliveryStorage: DeliveryStorage = {
  getObjectBytes: () => Promise.reject(new Error('unused delivery storage')),
  streamObjectRange: () => Promise.reject(new Error('unused delivery storage')),
  putWatermark: () => Promise.reject(new Error('unused delivery storage')),
  putExport: () => Promise.reject(new Error('unused delivery storage')),
  deleteObject: () => Promise.reject(new Error('unused delivery storage')),
};

export function testReadiness(database: Pool): ReadinessDependencies {
  return {
    database,
    extensions: [
      { name: 'storage', check: () => Promise.resolve({ healthy: true, code: 'ok' }) },
      { name: 'scanner', check: () => Promise.resolve({ healthy: true, code: 'ok' }) },
    ],
    manifestConsistent: () => true,
    migrationsApplied: () => Promise.resolve(true),
    jobsCompatible: () => Promise.resolve(true),
  };
}

/** Test-only wrapper: production callers cannot omit readiness dependencies. */
export function buildTestWebApp(
  dependencies: Omit<WebDependencies, 'readiness'> &
    Partial<Pick<WebDependencies, 'readiness'>>,
) {
  return buildWebApp({
    readiness: testReadiness(dependencies.runtime.pool),
    ...dependencies,
  });
}

export function testWebRuntime(overrides: Partial<WebRuntime> = {}): WebRuntime {
  const oidcConfig = new oidc.Configuration(
    {
      issuer: 'https://issuer.example',
      authorization_endpoint: 'https://issuer.example/authorize',
      token_endpoint: 'https://issuer.example/token',
      jwks_uri: 'https://issuer.example/jwks',
    },
    'client',
  );
  return {
    authPool:
      overrides.authPool ??
      overrides.pool ??
      new Pool({ connectionString: 'postgresql://unused:unused@127.0.0.1:1/unused' }),
    pool:
      overrides.pool ??
      new Pool({ connectionString: 'postgresql://unused:unused@127.0.0.1:1/unused' }),
    oidc: overrides.oidc ?? oidcConfig,
    oidcRedirectUri: 'https://duefold.example/api/auth/oidc/callback',
    ownerAllowlist: ['owner@example.com'],
    organizationName: 'Duefold Test',
    afterAuthenticationPath: '/',
    otpDigestKey: Buffer.alloc(32, 1).toString('base64url'),
    networkHmacKey: Buffer.alloc(32, 2).toString('base64url'),
    sessionPolicy: { idleMinutes: 30, absoluteHours: 12 },
    clock: new FixedClock(new Date('2026-03-01T00:00:00Z')),
    storage: unusedStorage,
    deliveryStorage: unusedDeliveryStorage,
    watermarkProgram: sandboxProgram(process.execPath),
    classifyClient: () => ({ browser: 'other', os: 'other', device: 'other' }),
    deliverOtp: () => Promise.resolve(),
    revokeSession: () => Promise.resolve(),
    ...overrides,
  };
}
