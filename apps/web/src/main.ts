import { Pool } from 'pg';
import { fileURLToPath } from 'node:url';
import { discoverOidc } from '../../../modules/core-security/src/auth/oidc.ts';
import { generatedConfigSchema } from '../../../.duefold/generated/config-schema.ts';
import { systemClock } from '@duefold/shared/clock';
import { installProcessFailureHandlers } from '@duefold/shared/process-errors';
import { loadConfig } from '../../../modules/core-security/src/config.ts';
import { appendAudit } from '../../../modules/core-security/src/audit.ts';
import { createDatabase } from '../../../modules/core-security/src/db/database.ts';
import { createCorrelationId } from '@duefold/shared/ids';
import { createConfiguredMailer } from '../../../modules/core-security/src/auth/mail.ts';
import { composedManifest } from '../../../.duefold/generated/manifest.ts';
import { generatedJobs } from '../../../.duefold/generated/jobs.ts';
import { generatedMigrations } from '../../../.duefold/generated/migrations.ts';
import {
  createWebStorage,
  createDeliveryStorage,
  webStorageConfig,
} from '../../../modules/rooms-documents/src/storage/s3-compatible.ts';
import { buildWebApp } from './app.ts';
import { createSessionAuthenticator } from './authenticate.ts';
import { assertDistinctDatabaseRoles } from './database-roles.ts';
import { loadStaticClient } from './static-client.ts';
import { parseTrustedProxies } from './proxy.ts';
import { sandboxProgram } from '../../../modules/rooms-documents/src/processing/sandbox.ts';
import { resolveSandboxIsolation } from '../../../modules/rooms-documents/src/processing/preflight.ts';
import type { CoarseClient } from '../../../modules/core-security/src/auth/otp.ts';
import type { WebRuntime } from './runtime.ts';
import { createClamAvClient } from '../../../modules/rooms-documents/src/scanning/clamav.ts';
import {
  allMigrationsApplied,
  queuedJobsCompatible,
} from '../../../modules/core-security/src/routes/health-ready.ts';

const webConfigSchema = generatedConfigSchema.filter(
  (field) => field.service === 'web' || field.service === 'shared',
);

let closeResources: () => Promise<void> = () => Promise.resolve();
let startupStage: 'config' | 'oidc' | 'database' | 'application' | 'listen' = 'config';
const terminate = installProcessFailureHandlers('web', {
  close: () => closeResources(),
  stage: () => startupStage,
});

function stringConfig(
  config: Readonly<Record<string, string | number | boolean>>,
  key: string,
): string {
  const value = config[key];
  if (typeof value !== 'string' || value === '')
    throw new Error(`invalid configuration: ${key}`);
  return value;
}
function numberConfig(
  config: Readonly<Record<string, string | number | boolean>>,
  key: string,
): number {
  const value = config[key];
  if (typeof value !== 'number') throw new Error(`invalid configuration: ${key}`);
  return value;
}
function classifyClient(): CoarseClient {
  return { browser: 'other', os: 'other', device: 'other' };
}

try {
  const config = loadConfig(webConfigSchema, process.env);
  const sandboxIsolation = resolveSandboxIsolation({
    isolation: stringConfig(config, 'DUEFOLD_SANDBOX_ISOLATION'),
    ...(typeof config['DUEFOLD_SANDBOX_DEGRADED_ACKNOWLEDGEMENT'] === 'string'
      ? { acknowledgement: config['DUEFOLD_SANDBOX_DEGRADED_ACKNOWLEDGEMENT'] }
      : {}),
  });
  if (sandboxIsolation.mode === 'degraded')
    process.stderr.write(
      `${JSON.stringify({
        event: 'sandbox.degraded',
        level: 'warn',
        code: 'SANDBOX_ISOLATION_DEGRADED',
        service: 'web',
        detail:
          'watermark composition runs as a separate unprivileged uid without filesystem or network isolation',
      })}\n`,
    );
  const databaseUrl = stringConfig(config, 'DUEFOLD_DATABASE_URL');
  const authenticatorDatabaseUrl = stringConfig(config, 'DUEFOLD_AUTH_DATABASE_URL');
  const publicUrl = new URL(stringConfig(config, 'DUEFOLD_PUBLIC_URL'));
  const oidcRedirectUri = new URL('/api/auth/oidc/callback', publicUrl).toString();
  startupStage = 'oidc';
  const oidcConfig = await discoverOidc({
    issuer: new URL(stringConfig(config, 'DUEFOLD_OIDC_ISSUER')),
    clientId: stringConfig(config, 'DUEFOLD_OIDC_CLIENT_ID'),
    clientSecret: stringConfig(config, 'DUEFOLD_OIDC_CLIENT_SECRET'),
    redirectUri: oidcRedirectUri,
  });
  startupStage = 'database';
  const pool = new Pool({ connectionString: databaseUrl, application_name: 'duefold-web' });
  const authPool = new Pool({
    connectionString: authenticatorDatabaseUrl,
    application_name: 'duefold-authenticator',
  });
  await assertDistinctDatabaseRoles(pool, authPool);
  const database = createDatabase(databaseUrl);
  const authDatabase = createDatabase(authenticatorDatabaseUrl);
  const sessionPolicy = {
    idleMinutes: numberConfig(config, 'DUEFOLD_SESSION_IDLE_MINUTES'),
    absoluteHours: numberConfig(config, 'DUEFOLD_SESSION_ABSOLUTE_HOURS'),
  };
  const mailer = createConfiguredMailer({
    adapter: composedManifest.adapters.mail,
    from: stringConfig(config, 'DUEFOLD_AUTH_MAIL_FROM'),
    ...(typeof config['DUEFOLD_SMTP_URL'] === 'string' && config['DUEFOLD_SMTP_URL'] !== ''
      ? { smtpUrl: config['DUEFOLD_SMTP_URL'] }
      : {}),
    ...(typeof config['DUEFOLD_RESEND_API_KEY'] === 'string' &&
    config['DUEFOLD_RESEND_API_KEY'] !== ''
      ? { resendApiKey: config['DUEFOLD_RESEND_API_KEY'] }
      : {}),
  });
  const storage = createWebStorage(
    webStorageConfig({
      endpoint: stringConfig(config, 'DUEFOLD_STORAGE_ENDPOINT'),
      region: stringConfig(config, 'DUEFOLD_STORAGE_REGION'),
      bucket: stringConfig(config, 'DUEFOLD_STORAGE_BUCKET'),
      credentials: {
        accessKeyId: stringConfig(config, 'DUEFOLD_STORAGE_WEB_ACCESS_KEY_ID'),
        secretAccessKey: stringConfig(config, 'DUEFOLD_STORAGE_WEB_SECRET_ACCESS_KEY'),
      },
      pathStyle: config['DUEFOLD_STORAGE_PATH_STYLE'] === true,
      checksumSupport: config['DUEFOLD_STORAGE_CHECKSUM_SUPPORT'] === true,
    }),
  );
  const scanner = createClamAvClient({
    socket: {
      host: stringConfig(config, 'DUEFOLD_CLAMAV_HOST'),
      port: numberConfig(config, 'DUEFOLD_CLAMAV_PORT'),
    },
    timeoutMilliseconds: 5_000,
  });
  const runtime: WebRuntime = {
    pool,
    authPool,
    oidc: oidcConfig,
    oidcRedirectUri,
    ownerAllowlist: stringConfig(config, 'DUEFOLD_OWNER_EMAIL_ALLOWLIST').split(','),
    organizationName: stringConfig(config, 'DUEFOLD_ORGANIZATION_NAME'),
    afterAuthenticationPath: '/',
    otpDigestKey: stringConfig(config, 'DUEFOLD_OTP_DIGEST_KEY'),
    networkHmacKey: stringConfig(config, 'DUEFOLD_NETWORK_HMAC_KEY'),
    sessionPolicy,
    clock: systemClock,
    storage,
    deliveryStorage: createDeliveryStorage(
      webStorageConfig({
        endpoint: stringConfig(config, 'DUEFOLD_STORAGE_ENDPOINT'),
        region: stringConfig(config, 'DUEFOLD_STORAGE_REGION'),
        bucket: stringConfig(config, 'DUEFOLD_STORAGE_BUCKET'),
        credentials: {
          accessKeyId: stringConfig(config, 'DUEFOLD_STORAGE_WEB_ACCESS_KEY_ID'),
          secretAccessKey: stringConfig(config, 'DUEFOLD_STORAGE_WEB_SECRET_ACCESS_KEY'),
        },
        pathStyle: config['DUEFOLD_STORAGE_PATH_STYLE'] === true,
        checksumSupport: config['DUEFOLD_STORAGE_CHECKSUM_SUPPORT'] === true,
      }),
    ),
    watermarkProgram: sandboxProgram(process.execPath, [
      fileURLToPath(
        new URL(
          '../../../modules/rooms-documents/src/processing/watermark-adapter.ts',
          import.meta.url,
        ),
      ),
      stringConfig(config, 'DUEFOLD_WATERMARK_IMAGE_PROGRAM'),
    ]),
    classifyClient,
    ...(sandboxIsolation.mode === 'namespaced' ? {} : { sandboxIsolation }),
    deliverOtp: (message) => mailer.deliver(message),
    revokeSession: async (sessionId, principal) => {
      await authDatabase.transaction().execute(async (transaction) => {
        const result = await transaction
          .updateTable('session')
          .set({ state: 'revoked' })
          .where('id', '=', sessionId)
          .where('state', '=', 'active')
          .executeTakeFirst();
        if (result.numUpdatedRows !== 1n) throw new Error('session is not active');
        await appendAudit(transaction, {
          eventType: 'session.revoked',
          actorKind: principal.kind,
          actorId: principal.id,
          subjectId: sessionId,
          result: 'success',
          reasonCode: 'SIGN_OUT',
          correlationId: createCorrelationId(),
        });
      });
    },
  };
  const trustedProxiesRaw =
    typeof config['DUEFOLD_TRUSTED_PROXIES'] === 'string'
      ? config['DUEFOLD_TRUSTED_PROXIES']
      : undefined;
  startupStage = 'application';
  const app = await buildWebApp({
    runtime,
    readiness: {
      database: pool,
      extensions: [
        {
          name: 'storage',
          check: async () => {
            await storage.checkReady();
            return { healthy: true, code: 'ok' };
          },
        },
        {
          name: 'scanner',
          check: async () => {
            await scanner.checkReady();
            return { healthy: true, code: 'ok' };
          },
        },
      ],
      manifestConsistent: () =>
        composedManifest.modules.length > 0 &&
        new Set(composedManifest.modules).size === composedManifest.modules.length,
      migrationsApplied: () => allMigrationsApplied(pool, generatedMigrations),
      jobsCompatible: () =>
        queuedJobsCompatible(
          pool,
          generatedJobs.map(({ id }) => id),
        ),
    },
    authenticate: createSessionAuthenticator(authPool, sessionPolicy),
    trustProxy: parseTrustedProxies(trustedProxiesRaw),
    // Fails startup when the client has not been built, rather than serving
    // nothing and looking like a routing fault.
    staticClient: await loadStaticClient(
      fileURLToPath(new URL('../../web-client/dist', import.meta.url)),
    ),
  });
  app.addHook('onClose', async () => {
    mailer.close();
    await authDatabase.destroy();
    await database.destroy();
    await authPool.end();
    await pool.end();
  });
  closeResources = () => app.close();
  startupStage = 'listen';
  await app.listen({ host: '0.0.0.0', port: numberConfig(config, 'DUEFOLD_PORT') });
} catch {
  terminate();
}
