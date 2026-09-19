import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

const execute = promisify(execFile);
const databaseName = 'duefold_cli_reset_test';
const fatalSecret = 'entry-point-fatal-secret';
const entryPoints = {
  web: 'apps/web/src/main.ts',
  worker: 'apps/worker/src/main.ts',
  cli: 'apps/cli/src/main.ts',
} as const;
const bootstrapPool = new Pool({
  host: '/var/run/postgresql',
  database: 'postgres',
});

interface RefusingDependency {
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Binds a listener that immediately destroys every accepted socket and keeps it
 * bound for the child's lifetime.
 *
 * Probing for a free port and then releasing it would be a TOCTOU race: another
 * process could take the port and turn the "unreachable" dependency into a
 * reachable one. Holding the port and resetting connections makes the child's
 * dependency failure deterministic.
 */
async function refusingDependency(): Promise<RefusingDependency> {
  const server = createServer((socket) => {
    socket.destroy();
  });
  server.on('error', () => undefined);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('ephemeral TCP port unavailable');
  }
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
}

function fatalEnvironment(port: number): NodeJS.ProcessEnv {
  const unavailableDatabase = `postgresql://duefold_runtime:${fatalSecret}@127.0.0.1:${String(port)}/duefold_entrypoint_test`;
  return {
    PATH: process.env['PATH'],
    HOME: process.env['HOME'],
    DUEFOLD_DATABASE_URL: unavailableDatabase,
    DUEFOLD_AUTH_DATABASE_URL: unavailableDatabase,
    DUEFOLD_WORKER_DATABASE_URL: unavailableDatabase,
    DUEFOLD_MIGRATION_DATABASE_URL: unavailableDatabase,
    DUEFOLD_PUBLIC_URL: 'https://duefold.example',
    DUEFOLD_OIDC_ISSUER: `http://127.0.0.1:${String(port)}`,
    DUEFOLD_OIDC_CLIENT_ID: 'client',
    DUEFOLD_OIDC_CLIENT_SECRET: fatalSecret,
    DUEFOLD_OWNER_EMAIL_ALLOWLIST: 'owner@example.com',
    DUEFOLD_ORGANIZATION_NAME: 'Duefold Test',
    DUEFOLD_OTP_DIGEST_KEY: Buffer.alloc(32, 1).toString('base64url'),
    DUEFOLD_NETWORK_HMAC_KEY: Buffer.alloc(32, 2).toString('base64url'),
    DUEFOLD_PII_HMAC_KEY: Buffer.alloc(32, 3).toString('base64url'),
    DUEFOLD_SMTP_URL: `smtp://127.0.0.1:${String(port)}`,
    DUEFOLD_AUTH_MAIL_FROM: 'no-reply@example.com',
    DUEFOLD_STORAGE_ENDPOINT: `http://127.0.0.1:${String(port)}`,
    DUEFOLD_STORAGE_REGION: 'us-east-1',
    DUEFOLD_STORAGE_BUCKET: 'duefold',
    DUEFOLD_STORAGE_PATH_STYLE: 'true',
    DUEFOLD_STORAGE_CHECKSUM_SUPPORT: 'false',
    DUEFOLD_STORAGE_WEB_ACCESS_KEY_ID: 'web-access',
    DUEFOLD_STORAGE_WEB_SECRET_ACCESS_KEY: fatalSecret,
    DUEFOLD_STORAGE_WORKER_ACCESS_KEY_ID: 'worker-access',
    DUEFOLD_STORAGE_WORKER_SECRET_ACCESS_KEY: fatalSecret,
    DUEFOLD_CLAMAV_HOST: '127.0.0.1',
    DUEFOLD_CLAMAV_PORT: String(port),
    DUEFOLD_PROCESSOR_OFFICE_PROGRAM: '/usr/bin/libreoffice',
    DUEFOLD_PROCESSOR_PDF_PROGRAM: '/usr/bin/mutool',
    DUEFOLD_PROCESSOR_IMAGE_PROGRAM: '/usr/bin/magick',
    DUEFOLD_PROCESSOR_TEXT_PROGRAM: '/usr/bin/duefold-text-renderer',
    DUEFOLD_SANDBOX_MODE: 'production',
  };
}

/**
 * Waits until no backend remains connected to the test database.
 *
 * `DROP DATABASE ... WITH (FORCE)` terminates other backends, which races a
 * client that is still closing and surfaces as an unhandled `57P01`. Vitest
 * warns that such an unhandled error can produce false positives, so teardown
 * waits for a genuinely idle database and then drops it without FORCE.
 */
async function waitForNoConnections(name: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const result = await bootstrapPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [name],
    );
    if (result.rows[0]?.count === '0') return;
    if (Date.now() >= deadline) {
      throw new Error(`connections to ${name} did not close before teardown`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeAll(async () => {
  await waitForNoConnections(databaseName);
  await bootstrapPool.query(`DROP DATABASE IF EXISTS ${databaseName}`);
  await bootstrapPool.query(`CREATE DATABASE ${databaseName} OWNER duefold_migration`);
});
afterAll(async () => {
  await waitForNoConnections(databaseName);
  await bootstrapPool.query(`DROP DATABASE IF EXISTS ${databaseName}`);
  await bootstrapPool.end();
});

describe('CLI operator guards', () => {
  it.each(Object.entries(entryPoints))(
    'terminates the %s entry point non-zero after a fatal dependency failure despite an active handle',
    async (service, entryPoint) => {
      const dependency = await refusingDependency();
      const directory = await mkdtemp(join(tmpdir(), 'duefold-fatal-'));
      const activeHandle = join(directory, 'active-handle.ts');
      await writeFile(activeHandle, 'setInterval(() => undefined, 60_000);\n');
      const startedAt = Date.now();
      try {
        await expect(
          execute(
            'node',
            [
              '--import',
              activeHandle,
              entryPoint,
              ...(service === 'cli' ? ['db', 'migrate'] : []),
            ],
            {
              cwd: process.cwd(),
              env: fatalEnvironment(dependency.port),
              timeout: 10_000,
              killSignal: 'SIGKILL',
            },
          ),
        ).rejects.toMatchObject({
          code: 1,
          killed: false,
          // The safe record is the security property: no thrown value, no
          // stack, no secret. stdout must stay empty so a mutation cannot
          // leak protected detail through the other stream.
          stdout: '',
          stderr: `${JSON.stringify({
            event: 'process.failure',
            level: 'error',
            code: 'PROCESS_FAILED',
            service,
            ...(service === 'web' ? { stage: 'config' } : {}),
          })}\n`,
        });
        expect(Date.now() - startedAt).toBeLessThan(10_000);
      } finally {
        await dependency.close();
      }
    },
  );

  it('executes db reset in a real CLI process when the generated guard is true', async () => {
    const migrationUrl = `postgresql://duefold_migration:duefold_local_migration@127.0.0.1:5432/${databaseName}`;
    const environment = {
      PATH: process.env['PATH'],
      HOME: process.env['HOME'],
      DUEFOLD_MIGRATION_DATABASE_URL: migrationUrl,
      DUEFOLD_DATABASE_URL: 'postgresql://unused',
      DUEFOLD_AUTH_DATABASE_URL: 'postgresql://unused',
      DUEFOLD_WORKER_DATABASE_URL: 'postgresql://unused',
      DUEFOLD_PUBLIC_URL: 'https://duefold.example',
      DUEFOLD_OIDC_ISSUER: 'https://issuer.example',
      DUEFOLD_OIDC_CLIENT_ID: 'client',
      DUEFOLD_OIDC_CLIENT_SECRET: 'secret',
      DUEFOLD_OWNER_EMAIL_ALLOWLIST: 'owner@example.com',
      DUEFOLD_ORGANIZATION_NAME: 'Duefold Test',
      DUEFOLD_OTP_DIGEST_KEY: Buffer.alloc(32, 1).toString('base64url'),
      DUEFOLD_NETWORK_HMAC_KEY: Buffer.alloc(32, 2).toString('base64url'),
      DUEFOLD_PII_HMAC_KEY: Buffer.alloc(32, 3).toString('base64url'),
      DUEFOLD_SMTP_URL: 'smtp://127.0.0.1:1025',
      DUEFOLD_AUTH_MAIL_FROM: 'no-reply@example.com',
      DUEFOLD_ALLOW_DB_RESET: 'true',
      DUEFOLD_STORAGE_ENDPOINT: 'http://127.0.0.1:9000',
      DUEFOLD_STORAGE_REGION: 'us-east-1',
      DUEFOLD_STORAGE_BUCKET: 'duefold',
      DUEFOLD_STORAGE_PATH_STYLE: 'true',
      DUEFOLD_STORAGE_CHECKSUM_SUPPORT: 'false',
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
      DUEFOLD_SANDBOX_MODE: 'production',
    };
    const result = await execute('node', ['apps/cli/src/main.ts', 'db', 'reset'], {
      cwd: process.cwd(),
      env: environment,
    });
    expect(result.stderr).toBe('');
    const verification = new Pool({ connectionString: migrationUrl });
    try {
      expect(
        (
          await verification.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM duefold_migration WHERE id = '001_security_kernel'",
          )
        ).rows[0]?.count,
      ).toBe('1');
    } finally {
      await verification.end();
    }
  });
});
