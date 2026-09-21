import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { generatedMigrations } from '../../.duefold/generated/migrations.ts';
import { migrate } from '../../modules/core-security/src/db/migrate.ts';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import { sandboxProgram } from '../../modules/rooms-documents/src/processing/sandbox.ts';
import { createHandler } from '../../modules/branding-notifications/src/jobs/branding-image.ts';
import type { WorkerStorage } from '../../modules/rooms-documents/src/storage/s3-compatible.ts';

const bootstrapPool = new Pool({
  host: '/var/run/postgresql',
  database: 'duefold_test',
});
const migrationPool = new Pool({
  connectionString: process.env['DUEFOLD_TEST_MIGRATION_DATABASE_URL'],
});
const runtimePool = new Pool({ connectionString: process.env['DUEFOLD_TEST_DATABASE_URL'] });
const workerPool = new Pool({
  connectionString: process.env['DUEFOLD_TEST_WORKER_DATABASE_URL'],
});
const ownerId = createOpaqueId();
function png(): Buffer {
  const b = Buffer.alloc(45);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(1, 16);
  b.writeUInt32BE(1, 20);
  b.writeUInt32BE(0, 33);
  b.write('IEND', 37, 'ascii');
  return b;
}
beforeAll(async () => {
  await bootstrapPool.query(
    'DROP SCHEMA public CASCADE; CREATE SCHEMA public; ALTER SCHEMA public OWNER TO duefold_migration',
  );
  await migrate(migrationPool, generatedMigrations);
  const client = await migrationPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO member(id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state) VALUES($1,'brand-owner@example.test','brand-owner@example.test','https://issuer.example','brand-owner','owner','active')",
      [ownerId],
    );
    await client.query("INSERT INTO organization(id,name) VALUES($1,'Brand')", [
      createOpaqueId(),
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});
afterAll(async () =>
  Promise.all([
    bootstrapPool.end(),
    migrationPool.end(),
    runtimePool.end(),
    workerPool.end(),
  ]).then(() => undefined),
);
describe('branding quarantine lifecycle', () => {
  it('drives an owner upload through worker scan and sandbox re-encode to sanitized storage', async () => {
    const intentId = createOpaqueId(),
      jobId = createOpaqueId(),
      sourceKey = `quarantine/${createOpaqueId()}/${createOpaqueId()}`;
    await runtimePool.query(
      'SELECT create_branding_upload_intent($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        intentId,
        ownerId,
        'logo',
        'image/png',
        png().length,
        sourceKey,
        'upload-1',
        createOpaqueId(),
        createCorrelationId(),
      ],
    );
    await runtimePool.query('SELECT finalize_branding_upload($1,$2,$3,$4,$5,$6)', [
      intentId,
      ownerId,
      png().length,
      jobId,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    const owner = 'brand-worker',
      token = 'T'.repeat(32);
    await migrationPool.query(
      "UPDATE job_queue SET state='running',attempts=1,lease_owner=$2,lease_token=$3,lease_expires_at=statement_timestamp()+interval '2 minutes' WHERE id=$1",
      [jobId, owner, token],
    );
    const written = new Map<string, Uint8Array>();
    const deleted: string[] = [];
    const storage = {
      checksumSupport: true,
      checkReady: () => Promise.resolve(),
      createMultipart: () => Promise.reject(new Error('UNUSED')),
      presignPart: () => Promise.reject(new Error('UNUSED')),
      completeMultipart: () => Promise.reject(new Error('UNUSED')),
      abortMultipart: () => Promise.reject(new Error('UNUSED')),
      headObject: () => Promise.reject(new Error('UNUSED')),
      getObjectBytes: (key: string) =>
        key === sourceKey ? Promise.resolve(png()) : Promise.reject(new Error('ABSENT')),
      streamObject: () => Promise.reject(new Error('UNUSED')),
      putExportStream: () => Promise.reject(new Error('UNUSED')),
      putBrandingAsset: (x: { key: string; bytes: Uint8Array }) => {
        written.set(x.key, x.bytes);
        return Promise.resolve();
      },
      putSystemDeletionMarker: () => Promise.reject(new Error('UNUSED')),
      putDerivative: () => Promise.reject(new Error('UNUSED')),
      deleteObject: (key: string) => {
        deleted.push(key);
        return Promise.resolve();
      },
    } satisfies WorkerStorage;
    const handler = createHandler({
      pool: workerPool,
      storage,
      scanner: {
        readSignatures: () =>
          Promise.resolve({ signatureVersion: 'fixture', signatureDate: new Date() }),
        checkReady: () =>
          Promise.resolve({ signatureVersion: 'fixture', signatureDate: new Date() }),
        scan: () =>
          Promise.resolve({
            result: 'clean' as const,
            signatureVersion: 'fixture',
            signatureDate: new Date(),
          }),
      },
      processorPrograms: { image: sandboxProgram(process.execPath) },
      invokeBrandingSandbox: () => Promise.resolve(png()),
    });
    await handler(
      {
        id: jobId,
        job_type: 'branding.image.process',
        payload: { intentId },
        attempts: 1,
        max_attempts: 5,
        lease_token: token,
      },
      {
        leaseOwner: owner,
        signal: new AbortController().signal,
        assertLease: () => Promise.resolve(),
      },
    );
    expect(written.size).toBe(1);
    expect([...written.keys()][0]).toMatch(/^branding\/.+\.png$/u);
    expect(deleted).toContain(sourceKey);
    expect(
      (
        await migrationPool.query<{ state: string }>(
          'SELECT state FROM branding_upload_intent WHERE id=$1',
          [intentId],
        )
      ).rows[0]?.state,
    ).toBe('ready');
  }, 30000);
});
