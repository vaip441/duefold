/**
 * `updates check-file` run through `runCli` as an operator runs it, recording into the real
 * database as the migration role.
 */
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../apps/cli/src/main.ts';
import { applicationVersion } from '../../modules/core-security/src/release.ts';
import {
  closePools,
  migrationDatabaseUrl,
  migrationPool,
  resetSchema,
} from '../authz/support/database.ts';

const keys = generateKeyPairSync('ed25519');
let directory = '';
let keyPath = '';
let output: string[] = [];
let previousExitCode: typeof process.exitCode;

beforeAll(async () => {
  await resetSchema();
  directory = await mkdtemp(join(tmpdir(), 'duefold-updates-'));
  keyPath = join(directory, 'release-signing-public.pem');
  await writeFile(keyPath, keys.publicKey.export({ format: 'pem', type: 'spki' }));
});
afterAll(closePools);
beforeEach(() => {
  output = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    output.push(String(line));
  });
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = previousExitCode;
});

async function manifest(version: string, securityAdvisory: boolean, tamper = false) {
  const payload = {
    version,
    webImageDigest: `sha256:${'a'.repeat(64)}`,
    workerImageDigest: `sha256:${'b'.repeat(64)}`,
    securityAdvisory,
  };
  const signature = sign(null, Buffer.from(JSON.stringify(payload)), keys.privateKey).toString(
    'base64url',
  );
  const path = join(directory, `${version}-${String(securityAdvisory)}-${String(tamper)}.json`);
  await writeFile(
    path,
    JSON.stringify({ ...payload, ...(tamper ? { version: '99.0.0' } : {}), signature }),
  );
  return path;
}

async function checkFile(path: string): Promise<void> {
  await runCli(['updates', 'check-file', path], {
    DUEFOLD_MIGRATION_DATABASE_URL: migrationDatabaseUrl,
    DUEFOLD_UPDATE_PUBLIC_KEY_PATH: keyPath,
  });
}

async function recorded() {
  return (
    await migrationPool.query<{
      result: string;
      code: string;
      evidence_version: string | null;
    }>(
      "SELECT result,code,evidence_version FROM deployment_status_observation WHERE check_name='updates'",
    )
  ).rows[0];
}

const newer = (): string => `${String(Number(applicationVersion().split('.')[0]) + 1)}.0.0`;

describe('updates check-file', () => {
  it('records the running release as current and exits cleanly', async () => {
    await checkFile(await manifest(applicationVersion(), false));
    expect(await recorded()).toStrictEqual({
      result: 'pass',
      code: 'UPDATE_CURRENT',
      evidence_version: null,
    });
    expect(output.join('\n')).toContain('"code":"UPDATE_CURRENT"');
    expect(process.exitCode).toBeUndefined();
  });

  it('records a newer release with a security advisory, names it, and fails the command', async () => {
    await checkFile(await manifest(newer(), true));
    expect(await recorded()).toStrictEqual({
      result: 'fail',
      code: 'SECURITY_ADVISORY',
      evidence_version: newer(),
    });
    expect(process.exitCode).toBe(1);
  });

  it('records a tampered manifest as unverified and fails the command', async () => {
    await checkFile(await manifest(newer(), false, true));
    expect(await recorded()).toStrictEqual({
      result: 'fail',
      code: 'UPDATE_MANIFEST_UNVERIFIED',
      evidence_version: null,
    });
    expect(process.exitCode).toBe(1);
  });
});
