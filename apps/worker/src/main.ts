import { generatedConfigSchema } from '../../../.duefold/generated/config-schema.ts';
import { systemClock } from '@duefold/shared/clock';
import { createResilientPool } from '@duefold/shared/database-pool';
import { installProcessFailureHandlers } from '@duefold/shared/process-errors';
import { loadConfig } from '../../../modules/core-security/src/config.ts';
import { createConfiguredMailer } from '../../../modules/core-security/src/auth/mail.ts';
import { composedManifest } from '../../../.duefold/generated/manifest.ts';
import {
  createWorkerStorage,
  workerStorageConfig,
} from '../../../modules/rooms-documents/src/storage/s3-compatible.ts';
import { createStorageStatusProbe } from '../../../modules/rooms-documents/src/storage/status-probe.ts';
import { JobRunner } from './runner.ts';
import { createClamAvClient } from '../../../modules/rooms-documents/src/scanning/clamav.ts';
import {
  enforceSandboxPreflight,
  resolveSandboxIsolation,
  sandboxPreflight,
} from '../../../modules/rooms-documents/src/processing/preflight.ts';
import { assertReleasePolicyIntegrity } from '../../../modules/rooms-documents/src/release-policy.ts';
import { createProcessorPrograms } from '../../../modules/rooms-documents/src/processing/formats.ts';

const workerConfigSchema = generatedConfigSchema.filter(
  (field) => field.service === 'worker' || field.service === 'shared',
);

let closeResources: () => Promise<void> = () => Promise.resolve();
const terminate = installProcessFailureHandlers('worker', {
  close: () => closeResources(),
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
try {
  const config = loadConfig(workerConfigSchema, process.env);
  assertReleasePolicyIntegrity();
  // Resolved before the preflight so a malformed isolation setting fails on its
  // own terms rather than as a confusing sandbox-unsupported error.
  const isolation = resolveSandboxIsolation({
    isolation: stringConfig(config, 'DUEFOLD_SANDBOX_ISOLATION'),
    ...(typeof config['DUEFOLD_SANDBOX_DEGRADED_ACKNOWLEDGEMENT'] === 'string'
      ? { acknowledgement: config['DUEFOLD_SANDBOX_DEGRADED_ACKNOWLEDGEMENT'] }
      : {}),
  }); // Degraded isolation cannot satisfy the namespaced preflight by construction,
  // so the probe is skipped rather than run and discarded: launching a real
  // sandbox child on every start to ignore its answer wastes a boot cycle and
  // invites the reader to think the boundary was checked. The acknowledgement is
  // what gates this mode, and the startup record states it plainly.
  if (isolation.mode === 'namespaced') {
    const sandboxReport = await sandboxPreflight();
    const sandboxMode = stringConfig(config, 'DUEFOLD_SANDBOX_MODE');
    enforceSandboxPreflight(
      sandboxReport,
      sandboxMode === 'development' ? 'development' : 'production',
      typeof config['DUEFOLD_SANDBOX_DEVELOPMENT_ACKNOWLEDGEMENT'] === 'string'
        ? config['DUEFOLD_SANDBOX_DEVELOPMENT_ACKNOWLEDGEMENT']
        : undefined,
    );
  } else
    process.stderr.write(
      `${JSON.stringify({
        event: 'sandbox.degraded',
        level: 'warn',
        code: 'SANDBOX_ISOLATION_DEGRADED',
        service: 'worker',
        detail:
          'untrusted document parsing runs as a separate unprivileged uid without filesystem or network isolation',
      })}\n`,
    );
  const pool = createResilientPool({
    role: 'worker',
    connectionString: stringConfig(config, 'DUEFOLD_WORKER_DATABASE_URL'),
    application_name: 'duefold-worker',
  });
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
  const storageConfig = workerStorageConfig({
    endpoint: stringConfig(config, 'DUEFOLD_STORAGE_ENDPOINT'),
    region: stringConfig(config, 'DUEFOLD_STORAGE_REGION'),
    bucket: stringConfig(config, 'DUEFOLD_STORAGE_BUCKET'),
    credentials: {
      accessKeyId: stringConfig(config, 'DUEFOLD_STORAGE_WORKER_ACCESS_KEY_ID'),
      secretAccessKey: stringConfig(config, 'DUEFOLD_STORAGE_WORKER_SECRET_ACCESS_KEY'),
    },
    pathStyle: config['DUEFOLD_STORAGE_PATH_STYLE'] === true,
    checksumSupport: config['DUEFOLD_STORAGE_CHECKSUM_SUPPORT'] === true,
  });
  const runner = new JobRunner(pool, {
    coreSecurity: {
      pool,
      otpDigestKey: stringConfig(config, 'DUEFOLD_OTP_DIGEST_KEY'),
      mailer,
      publicUrl: stringConfig(config, 'DUEFOLD_PUBLIC_URL'),
      clock: systemClock,
    },
    roomsDocuments: {
      pool,
      storage: createWorkerStorage(storageConfig),
      storageProbe: createStorageStatusProbe(storageConfig),
      piiHmacKey: stringConfig(config, 'DUEFOLD_PII_HMAC_KEY'),
      scanner: createClamAvClient({
        socket: {
          host: stringConfig(config, 'DUEFOLD_CLAMAV_HOST'),
          port: numberConfig(config, 'DUEFOLD_CLAMAV_PORT'),
        },
        timeoutMilliseconds: 30_000,
      }),
      processorPrograms: createProcessorPrograms({
        pdf: stringConfig(config, 'DUEFOLD_PROCESSOR_PDF_PROGRAM'),
        office: stringConfig(config, 'DUEFOLD_PROCESSOR_OFFICE_PROGRAM'),
        image: stringConfig(config, 'DUEFOLD_PROCESSOR_IMAGE_PROGRAM'),
        text: stringConfig(config, 'DUEFOLD_PROCESSOR_TEXT_PROGRAM'),
      }),
      ...(isolation.mode === 'namespaced' ? {} : { isolation }),
    },
  });
  closeResources = async () => {
    mailer.close();
    await pool.end();
  };
  const controller = new AbortController();
  process.once('SIGTERM', () => {
    controller.abort();
  });
  process.once('SIGINT', () => {
    controller.abort();
  });
  try {
    await runner.run({ signal: controller.signal });
  } finally {
    mailer.close();
    await pool.end();
  }
} catch {
  terminate();
}
