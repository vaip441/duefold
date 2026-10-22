/**
 * Cleanup that follows an outcome already settled: a failed upload completion and a
 * validation job that ran out of attempts. Each cleanup is best effort, so a fault in it
 * must neither replace the outcome nor strand what it was meant to clear.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOpaqueId } from '@duefold/shared/ids';
import type { TelemetryRecord } from '@duefold/shared/redact';
import { JobRunner } from '../../apps/worker/src/runner.ts';
import type { MemberIdentity } from '../../modules/core-security/src/authorization.ts';
import { createHandler as createMultipartReapHandler } from '../../modules/rooms-documents/src/jobs/multipart-reap.ts';
import {
  createWebStorage,
  webStorageConfig,
  type MultipartIdentity,
  type WebStorage,
} from '../../modules/rooms-documents/src/storage/s3-compatible.ts';
import {
  createUploadIntent,
  finalizeUpload,
} from '../../modules/rooms-documents/src/uploads.ts';
import {
  closePools,
  databasePool,
  migrationPool,
  workerPool,
} from '../authz/support/database.ts';
import { resetRoomSchema, seedMember, seedRoom } from '../authz/support/room-fixture.ts';
import { startS3TestEndpoint, type S3TestEndpoint } from '../support/s3-endpoint.ts';

const silentLog = { warn: () => undefined };
let endpoint: S3TestEndpoint;
let storage: WebStorage;
let owner: MemberIdentity;
let roomId = '';

beforeAll(async () => {
  const ownerId = await resetRoomSchema('Upload Cleanup');
  owner = { kind: 'member', id: ownerId, globalRole: 'owner', roomRoles: {} };
  roomId = await seedRoom(ownerId, 'Upload Cleanup');
  /* Only the job a case makes due is claimed, so seeded sweeps are moved out of the way. */
  await migrationPool.query("UPDATE job_queue SET available_at = 'infinity'");
  endpoint = await startS3TestEndpoint();
  storage = createWebStorage(
    webStorageConfig({
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
});
afterAll(async () => {
  await endpoint.close();
  await closePools();
});

async function uploadedIntent(text: string) {
  const created = await createUploadIntent({
    pool: databasePool,
    storage,
    identity: owner,
    input: {
      roomId,
      displayTitle: `Cleanup ${createOpaqueId()}`,
      originalFilename: 'cleanup.txt',
      declaredMediaType: 'text/plain',
      declaredSize: Buffer.byteLength(text),
      parts: [{ partNumber: 1, size: Buffer.byteLength(text) }],
    },
    now: new Date(),
  });
  const uploaded = await fetch(created.parts[0]!.url, { method: 'PUT', body: text });
  const etag = uploaded.headers.get('etag');
  if (etag === null) throw new Error('etag missing');
  const objectKey = (
    await databasePool.query<{ object_key: string }>(
      'SELECT object_key FROM upload_intent WHERE id = $1',
      [created.intentId],
    )
  ).rows[0]?.object_key;
  if (objectKey === undefined) throw new Error('object key missing');
  return {
    intentId: created.intentId,
    objectKey,
    input: {
      intentId: created.intentId,
      uploadId: created.uploadId,
      parts: [{ partNumber: 1, etag }],
    },
  };
}

async function intentState(intentId: string): Promise<string | undefined> {
  return (
    await databasePool.query<{ state: string }>(
      'SELECT state FROM upload_intent WHERE id = $1',
      [intentId],
    )
  ).rows[0]?.state;
}

async function injectAuditFailure(eventType: string): Promise<() => Promise<void>> {
  await migrationPool.query(`CREATE FUNCTION fail_cleanup_audit_insert() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type = '${eventType}' THEN
      RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $$`);
  await migrationPool.query(
    'CREATE TRIGGER fail_cleanup_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION fail_cleanup_audit_insert()',
  );
  return async () => {
    await migrationPool.query('DROP TRIGGER fail_cleanup_audit ON audit_event');
    await migrationPool.query('DROP FUNCTION fail_cleanup_audit_insert()');
  };
}

describe('a failed upload completion', () => {
  it('reports the completion failure when recording it fails, and still aborts the parts', async () => {
    const upload = await uploadedIntent('unrecorded failure');
    const aborted: MultipartIdentity[] = [];
    const logged: TelemetryRecord[] = [];
    const restore = await injectAuditFailure('upload.failed');
    try {
      await expect(
        finalizeUpload({
          pool: databasePool,
          storage: {
            ...storage,
            completeMultipart: () => Promise.reject(new Error('fixture completion failure')),
            abortMultipart: (identity) => {
              aborted.push(identity);
              return storage.abortMultipart(identity);
            },
          },
          identity: owner,
          input: upload.input,
          now: new Date(),
          log: { warn: (record) => logged.push(record) },
        }),
      ).rejects.toThrow('fixture completion failure');
    } finally {
      await restore();
    }
    expect(logged).toStrictEqual([
      { event: 'upload.cleanup.failed', code: 'UPLOAD_FAILURE_UNRECORDED' },
    ]);
    expect(aborted).toStrictEqual([{ key: upload.objectKey, uploadId: upload.input.uploadId }]);
  });

  it('reports the completion failure when deleting the completed object fails', async () => {
    const upload = await uploadedIntent('undeleted object');
    const logged: TelemetryRecord[] = [];
    await expect(
      finalizeUpload({
        pool: databasePool,
        storage: {
          ...storage,
          headObject: () => Promise.reject(new Error('fixture metadata failure')),
          deleteObject: () => Promise.reject(new Error('fixture delete failure')),
        },
        identity: owner,
        input: upload.input,
        now: new Date(),
        log: { warn: (record) => logged.push(record) },
      }),
    ).rejects.toThrow('fixture metadata failure');
    expect(logged).toStrictEqual([
      { event: 'upload.cleanup.failed', code: 'UPLOAD_OBJECT_DELETE_FAILED' },
    ]);
    expect(await intentState(upload.intentId)).toBe('failed');
  });

  it('keeps the completed object while the intent is completing, and the reaper clears it on expiry', async () => {
    const upload = await uploadedIntent('unmarked completed object');
    const deleted: string[] = [];
    const logged: TelemetryRecord[] = [];
    const restore = await injectAuditFailure('upload.failed');
    try {
      await expect(
        finalizeUpload({
          pool: databasePool,
          storage: {
            ...storage,
            headObject: () => Promise.reject(new Error('fixture metadata failure')),
            deleteObject: (key) => {
              deleted.push(key);
              return storage.deleteObject(key);
            },
          },
          identity: owner,
          input: upload.input,
          now: new Date(),
          log: { warn: (record) => logged.push(record) },
        }),
      ).rejects.toThrow('fixture metadata failure');
    } finally {
      await restore();
    }
    expect(logged).toStrictEqual([
      { event: 'upload.cleanup.failed', code: 'UPLOAD_FAILURE_UNRECORDED' },
    ]);
    expect(deleted).toStrictEqual([]);
    expect(await intentState(upload.intentId)).toBe('completing');
    await expect(storage.headObject(upload.objectKey)).resolves.toMatchObject({
      contentType: 'text/plain',
    });

    await migrationPool.query(
      `UPDATE upload_intent SET created_at = transaction_timestamp() - interval '1 day',
         expires_at = transaction_timestamp() - interval '1 second' WHERE id = $1`,
      [upload.intentId],
    );
    await workerPool.query(
      `UPDATE job_queue SET available_at = transaction_timestamp()
       WHERE job_type = 'upload.multipart.reap' AND payload->>'intentId' = $1`,
      [upload.intentId],
    );
    const runner = new JobRunner(
      workerPool,
      new Map([
        ['upload.multipart.reap', createMultipartReapHandler({ pool: workerPool, storage })],
      ]),
    );
    expect(await runner.runOne()).toBe(true);
    await expect(storage.headObject(upload.objectKey)).rejects.toThrow();
    expect(await intentState(upload.intentId)).toBe('expired');
  });

  it('is cleared by the reaper when storage completed the object and the abort failed', async () => {
    const upload = await uploadedIntent('completed behind a failure');
    await expect(
      finalizeUpload({
        pool: databasePool,
        storage: {
          ...storage,
          completeMultipart: async (input) => {
            await storage.completeMultipart(input);
            throw new Error('fixture lost completion response');
          },
          abortMultipart: () => Promise.reject(new Error('fixture abort failure')),
        },
        identity: owner,
        input: upload.input,
        now: new Date(),
        log: silentLog,
      }),
    ).rejects.toThrow('fixture lost completion response');
    expect(await intentState(upload.intentId)).toBe('failed');
    await expect(storage.headObject(upload.objectKey)).resolves.toMatchObject({
      contentType: 'text/plain',
    });

    const reaped: MultipartIdentity[] = [];
    const runner = new JobRunner(
      workerPool,
      new Map([
        [
          'upload.multipart.reap',
          createMultipartReapHandler({
            pool: workerPool,
            storage: {
              ...storage,
              abortMultipart: (identity) => {
                reaped.push(identity);
                return storage.abortMultipart(identity);
              },
            },
          }),
        ],
      ]),
    );
    await workerPool.query(
      `UPDATE job_queue SET available_at = transaction_timestamp()
       WHERE job_type = 'upload.multipart.reap' AND payload->>'intentId' = $1`,
      [upload.intentId],
    );
    expect(await runner.runOne()).toBe(true);
    expect(reaped).toStrictEqual([{ key: upload.objectKey, uploadId: upload.input.uploadId }]);
    await expect(storage.headObject(upload.objectKey)).rejects.toThrow();
    expect(await intentState(upload.intentId)).toBe('failed');
    expect(
      (
        await workerPool.query<{ state: string }>(
          "SELECT state FROM job_queue WHERE job_type = 'upload.multipart.reap' AND payload->>'intentId' = $1",
          [upload.intentId],
        )
      ).rows[0]?.state,
    ).toBe('succeeded');
    expect(await runner.runOne(), 'the reap job is not queued again').toBe(false);
  });
});

describe('finalizing an upload intent', () => {
  it('denies an outsider alike whether the intent is absent, open, or no longer open', async () => {
    const outsiderId = await seedMember('member', 'upload-outsider');
    const outsider: MemberIdentity = {
      kind: 'member',
      id: outsiderId,
      globalRole: 'member',
      roomRoles: {},
    };
    const open = await uploadedIntent('outsider open');
    const closed = await uploadedIntent('outsider closed');
    await migrationPool.query("UPDATE upload_intent SET state = 'failed' WHERE id = $1", [
      closed.intentId,
    ]);
    for (const input of [
      { ...open.input, intentId: createOpaqueId() },
      open.input,
      closed.input,
    ])
      await expect(
        finalizeUpload({
          pool: databasePool,
          storage,
          identity: outsider,
          input,
          now: new Date(),
          log: silentLog,
        }),
      ).rejects.toThrow('UPLOAD_FORBIDDEN');
  });

  it('answers its own uploader a conflict, not a denial, for an intent no longer open', async () => {
    const upload = await uploadedIntent('owner closed');
    await migrationPool.query("UPDATE upload_intent SET state = 'failed' WHERE id = $1", [
      upload.intentId,
    ]);
    await expect(
      finalizeUpload({
        pool: databasePool,
        storage,
        identity: owner,
        input: upload.input,
        now: new Date(),
        log: silentLog,
      }),
    ).rejects.toThrow('UPLOAD_INTENT_INVALID');
  });

  it('answers a conflict when the intent stops completing while storage assembles it', async () => {
    const upload = await uploadedIntent('reaped mid-finalize');
    const logged: TelemetryRecord[] = [];
    await expect(
      finalizeUpload({
        pool: databasePool,
        storage: {
          ...storage,
          completeMultipart: async (identity) => {
            await storage.completeMultipart(identity);
            await migrationPool.query(
              "UPDATE upload_intent SET state = 'expired' WHERE id = $1",
              [upload.intentId],
            );
          },
        },
        identity: owner,
        input: upload.input,
        now: new Date(),
        log: { warn: (record) => logged.push(record) },
      }),
    ).rejects.toThrow('UPLOAD_INTENT_INVALID');
    expect(logged, 'the reaper owns this cleanup').toStrictEqual([]);
  });
});

describe('a validation job that exhausted its attempts', () => {
  it('still lets the runner claim other work when failing the version raises, and retries it', async () => {
    const upload = await uploadedIntent('exhausted validation');
    const { versionId } = await finalizeUpload({
      pool: databasePool,
      storage,
      identity: owner,
      input: upload.input,
      now: new Date(),
      log: silentLog,
    });
    await workerPool.query(
      `UPDATE job_queue SET state = 'running',attempts = max_attempts,lease_owner = $2,
         lease_token = $3,lease_expires_at = transaction_timestamp() - interval '1 second',
         available_at = '2000-01-01'
       WHERE job_type = 'document.source.validate' AND payload->>'versionId' = $1`,
      [versionId, createOpaqueId(), createOpaqueId()],
    );
    const otherJobId = createOpaqueId();
    await migrationPool.query(
      `INSERT INTO job_queue (id,job_type,idempotency_key,payload,available_at)
       VALUES ($1,'status.observe','upload-cleanup:'||$1,'{}'::jsonb,'2000-01-02')`,
      [otherJobId],
    );
    const restore = await injectAuditFailure('document.processing');
    const claimed: string[] = [];
    const telemetry: string[] = [];
    const runner = new JobRunner(
      workerPool,
      new Map([
        [
          'status.observe',
          (job) => {
            claimed.push(job.id);
            return Promise.resolve();
          },
        ],
      ]),
      { sink: { write: (chunk) => telemetry.push(chunk) > 0 } },
    );
    try {
      expect(await runner.runOne()).toBe(true);
    } finally {
      await restore();
    }
    expect(claimed).toStrictEqual([otherJobId]);
    expect(telemetry.map((chunk) => JSON.parse(chunk) as unknown)).toStrictEqual([
      {
        event: 'job.exhaustion.failed',
        level: 'error',
        code: 'EXHAUSTED_WORK_FAILED',
        service: 'worker',
      },
    ]);
    const validation = async () =>
      (
        await workerPool.query<{ state: string; last_error_code: string; deferred: boolean }>(
          `SELECT state,last_error_code,available_at > transaction_timestamp() AS deferred
           FROM job_queue WHERE job_type = 'document.source.validate' AND payload->>'versionId' = $1`,
          [versionId],
        )
      ).rows[0];
    expect(await validation()).toStrictEqual({
      state: 'running',
      last_error_code: 'EXHAUSTION_HOOK_FAILED',
      deferred: true,
    });
    expect(await runner.runOne(), 'the deferred retry waits').toBe(false);

    await workerPool.query(
      `UPDATE job_queue SET available_at = '2000-01-01'
       WHERE job_type = 'document.source.validate' AND payload->>'versionId' = $1`,
      [versionId],
    );
    expect(await runner.runOne()).toBe(false);
    expect(await validation()).toMatchObject({
      state: 'failed',
      last_error_code: 'ATTEMPTS_EXHAUSTED',
    });
    expect(
      (
        await workerPool.query<{ state: string }>(
          'SELECT state FROM document_version WHERE id = $1',
          [versionId],
        )
      ).rows[0]?.state,
    ).toBe('processing_failed');
  });

  it('defers the job when its last attempt threw and failing the version raises', async () => {
    const upload = await uploadedIntent('thrown last attempt');
    const { versionId } = await finalizeUpload({
      pool: databasePool,
      storage,
      identity: owner,
      input: upload.input,
      now: new Date(),
      log: silentLog,
    });
    await workerPool.query(
      `UPDATE job_queue SET attempts = max_attempts - 1,available_at = '2000-01-01'
       WHERE job_type = 'document.source.validate' AND payload->>'versionId' = $1`,
      [versionId],
    );
    const telemetry: string[] = [];
    const runner = new JobRunner(
      workerPool,
      new Map([
        ['document.source.validate', () => Promise.reject(new Error('fixture last failure'))],
      ]),
      { sink: { write: (chunk) => telemetry.push(chunk) > 0 } },
    );
    const validation = async () =>
      (
        await workerPool.query<{ state: string; last_error_code: string; deferred: boolean }>(
          `SELECT state,last_error_code,available_at > transaction_timestamp() AS deferred
           FROM job_queue WHERE job_type = 'document.source.validate' AND payload->>'versionId' = $1`,
          [versionId],
        )
      ).rows[0];
    const restore = await injectAuditFailure('document.processing');
    try {
      expect(await runner.runOne()).toBe(true);
      expect(await validation()).toStrictEqual({
        state: 'running',
        last_error_code: 'HANDLER_FAILED',
        deferred: false,
      });
      expect(await runner.runOne()).toBe(false);
    } finally {
      await restore();
    }
    expect(telemetry).toHaveLength(1);
    expect(await validation()).toStrictEqual({
      state: 'running',
      last_error_code: 'EXHAUSTION_HOOK_FAILED',
      deferred: true,
    });

    await workerPool.query(
      `UPDATE job_queue SET available_at = '2000-01-01'
       WHERE job_type = 'document.source.validate' AND payload->>'versionId' = $1`,
      [versionId],
    );
    expect(await runner.runOne()).toBe(false);
    expect(await validation()).toMatchObject({
      state: 'failed',
      last_error_code: 'ATTEMPTS_EXHAUSTED',
    });
    expect(
      (
        await workerPool.query<{ state: string }>(
          'SELECT state FROM document_version WHERE id = $1',
          [versionId],
        )
      ).rows[0]?.state,
    ).toBe('processing_failed');
  });
});
