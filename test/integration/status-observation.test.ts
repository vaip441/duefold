/**
 * The hourly status observation, driven through the real `JobRunner` against the real
 * queue, the S3 test endpoint and the clamd double: the migration seeds it, the runner
 * reaches the handler, each observation is recorded, and the schedule re-arms under the
 * job's own lease.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generatedJobs } from '../../.duefold/generated/jobs.ts';
import { JobRunner } from '../../apps/worker/src/runner.ts';
import { CHECK_CODES } from '../../modules/core-security/src/status-observations.ts';
import {
  createHandler,
  type StatusObserveDependencies,
} from '../../modules/rooms-documents/src/jobs/status-observe.ts';
import { createClamAvClient } from '../../modules/rooms-documents/src/scanning/clamav.ts';
import { workerStorageConfig } from '../../modules/rooms-documents/src/storage/s3-compatible.ts';
import { createStorageStatusProbe } from '../../modules/rooms-documents/src/storage/status-probe.ts';
import {
  closePools,
  migrationPool,
  resetSchema,
  workerPool,
} from '../authz/support/database.ts';
import { startClamAvTestEndpoint } from '../support/clamav-endpoint.ts';
import { startS3TestEndpoint } from '../support/s3-endpoint.ts';

const endpoints: { close(): Promise<void> }[] = [];

beforeAll(resetSchema);
afterAll(async () => {
  for (const endpoint of endpoints) await endpoint.close();
  await closePools();
});

async function storage(options: Parameters<typeof startS3TestEndpoint>[0] = {}) {
  const endpoint = await startS3TestEndpoint(options);
  endpoints.push(endpoint);
  return createStorageStatusProbe(
    workerStorageConfig({
      endpoint: endpoint.endpoint,
      region: 'us-east-1',
      bucket: endpoint.bucket,
      credentials: {
        accessKeyId: endpoint.accessKeyId,
        secretAccessKey: endpoint.secretAccessKey,
      },
      pathStyle: true,
      checksumSupport: false,
    }),
  );
}

async function scanner(options: Parameters<typeof startClamAvTestEndpoint>[0]) {
  const endpoint = await startClamAvTestEndpoint(options);
  endpoints.push(endpoint);
  return createClamAvClient({
    socket: { host: endpoint.host, port: endpoint.port },
    timeoutMilliseconds: 5_000,
  });
}

async function observe(dependencies: Omit<StatusObserveDependencies, 'pool'>): Promise<void> {
  await migrationPool.query(
    `UPDATE job_queue SET available_at=statement_timestamp()-interval '1 minute'
      WHERE job_type='status.observe' AND state='pending'`,
  );
  const runner = new JobRunner(
    workerPool,
    new Map([['status.observe', createHandler({ pool: workerPool, ...dependencies })]]),
  );
  expect(await runner.runOne()).toBe(true);
}

async function observations() {
  return (
    await migrationPool.query<{
      check_name: string;
      result: string;
      code: string;
      evidence_at: Date | null;
    }>(
      'SELECT check_name,result,code,evidence_at FROM deployment_status_observation ORDER BY check_name',
    )
  ).rows;
}

describe('the status observation job', () => {
  it('is declared as a rooms-documents worker job under the id the migration seeds', () => {
    const declared = generatedJobs.find(({ id }) => id === 'status.observe');
    expect(declared).toMatchObject({ id: 'status.observe', module: 'rooms-documents' });
    expect(typeof declared?.handlerFactory).toBe('function');
  });

  it('is queued by the migration an hour out, so no deployment step arms it', async () => {
    const rows = (
      await migrationPool.query<{ state: string; idempotency_key: string; available_at: Date }>(
        "SELECT state,idempotency_key,available_at FROM job_queue WHERE job_type='status.observe'",
      )
    ).rows;
    expect(
      rows.map(({ state, idempotency_key }) => ({ state, idempotency_key })),
    ).toStrictEqual([{ state: 'pending', idempotency_key: 'status-observe:initial' }]);
    expect(rows[0]?.available_at.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
  });

  it('records storage privacy, versioning and current signatures with their build time', async () => {
    /* clamd's VERSION reply carries whole seconds. */
    const built = new Date(Math.floor(Date.now() / 1_000) * 1_000 - 3_600_000);
    await observe({
      storageProbe: await storage(),
      scanner: await scanner({ signatureDate: built }),
    });
    expect(await observations()).toStrictEqual([
      { check_name: 'scanner', result: 'pass', code: 'SIGNATURES_CURRENT', evidence_at: built },
      {
        check_name: 'storage-privacy',
        result: 'pass',
        code: 'ANONYMOUS_ACCESS_REFUSED',
        evidence_at: null,
      },
      {
        check_name: 'storage-versioning',
        result: 'pass',
        code: 'VERSIONING_ENABLED',
        evidence_at: null,
      },
    ]);
  });

  it('queues exactly one successor, an hour out', async () => {
    const pending = (
      await migrationPool.query<{ available_at: Date }>(
        "SELECT available_at FROM job_queue WHERE job_type='status.observe' AND state='pending'",
      )
    ).rows;
    expect(pending).toHaveLength(1);
    expect(pending[0]?.available_at.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
  });

  it('answers each dependency on its own, so one failure hides nothing', async () => {
    await observe({
      storageProbe: await storage({ versioning: 'not-implemented' }),
      scanner: await scanner({ signatureDate: new Date(), disconnectDuring: 'version' }),
    });
    expect(
      (await observations()).map(({ check_name, code, evidence_at }) => ({
        check_name,
        code,
        evidence_at,
      })),
    ).toStrictEqual([
      { check_name: 'scanner', code: 'SCANNER_UNAVAILABLE', evidence_at: null },
      { check_name: 'storage-privacy', code: 'ANONYMOUS_ACCESS_REFUSED', evidence_at: null },
      {
        check_name: 'storage-versioning',
        code: 'VERSIONING_NOT_DETECTABLE',
        evidence_at: null,
      },
    ]);
  });

  it('reports stale signatures as failing and keeps their build time', async () => {
    const built = new Date(Math.floor(Date.now() / 1_000) * 1_000 - 3 * 86_400_000);
    await observe({
      storageProbe: await storage({ versioning: 'Suspended' }),
      scanner: await scanner({ signatureDate: built }),
    });
    expect(await observations()).toContainEqual({
      check_name: 'scanner',
      result: 'fail',
      code: 'SIGNATURES_STALE',
      evidence_at: built,
    });
    expect(await observations()).toContainEqual({
      check_name: 'storage-versioning',
      result: 'attention',
      code: 'VERSIONING_SUSPENDED',
      evidence_at: null,
    });
  });

  it('records vocabulary codes when storage and scanner are unreachable, never provider messages', async () => {
    /* Probe pointing to an unreachable endpoint to simulate network/host outage. */
    const unreachableStorage = createStorageStatusProbe(
      workerStorageConfig({
        endpoint: 'http://127.0.0.1:1',
        region: 'us-east-1',
        bucket: 'unreachable-bucket',
        credentials: {
          accessKeyId: 'fake-key',
          secretAccessKey: 'fake-secret',
        },
        pathStyle: true,
        checksumSupport: false,
      }),
    );
    const unreachableScanner = createClamAvClient({
      socket: { host: '127.0.0.1', port: 1 },
      timeoutMilliseconds: 500,
    });

    await observe({
      storageProbe: unreachableStorage,
      scanner: unreachableScanner,
    });

    const rows = await observations();
    expect(rows).toStrictEqual([
      { check_name: 'scanner', result: 'fail', code: 'SCANNER_UNAVAILABLE', evidence_at: null },
      {
        check_name: 'storage-privacy',
        result: 'fail',
        code: 'STORAGE_UNREACHABLE',
        evidence_at: null,
      },
      {
        check_name: 'storage-versioning',
        result: 'fail',
        code: 'STORAGE_UNREACHABLE',
        evidence_at: null,
      },
    ]);

    for (const row of rows) {
      const allowedCodes = CHECK_CODES[
        row.check_name as keyof typeof CHECK_CODES
      ] as readonly string[];
      expect(allowedCodes).toContain(row.code);
      /* Must be an uppercase code, not a provider error message or URL. */
      expect(row.code).toMatch(/^[A-Z][A-Z0-9_]{0,63}$/);
      expect(row.code).not.toContain('http');
      expect(row.code).not.toContain('ECONNREFUSED');
      expect(row.code).not.toContain('unreachable-bucket');
    }
  });
});
