import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { generatedMigrations } from '../../.duefold/generated/migrations.ts';
import { migrate } from '../../modules/core-security/src/db/migrate.ts';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import {
  createUploadIntent,
  finalizeUpload,
} from '../../modules/rooms-documents/src/uploads.ts';
import {
  createWebStorage,
  createWorkerStorage,
  webStorageConfig,
  workerStorageConfig,
  type WebStorage,
} from '../../modules/rooms-documents/src/storage/s3-compatible.ts';
import { createHandler as createMultipartReapHandler } from '../../modules/rooms-documents/src/jobs/multipart-reap.ts';
import { createHandler as createSourceValidationHandler } from '../../modules/rooms-documents/src/jobs/source-validation.ts';
import { sandboxProgram } from '../../modules/rooms-documents/src/processing/sandbox.ts';
import { createClamAvClient } from '../../modules/rooms-documents/src/scanning/clamav.ts';
import {
  startClamAvTestEndpoint,
  type ClamAvTestEndpoint,
} from '../support/clamav-endpoint.ts';
import type { MemberIdentity } from '../../modules/core-security/src/authorization.ts';
import { JobRunner } from '../../apps/worker/src/runner.ts';
import { MAX_SOURCE_BYTES } from '../../modules/rooms-documents/src/resource-policy.ts';
import { startS3TestEndpoint, type S3TestEndpoint } from '../support/s3-endpoint.ts';

const fixtureProcessor = new URL(
  '../fixtures/processors/processor-fixture.mjs',
  import.meta.url,
).pathname;
function fixturePrograms(extractedText?: string) {
  const fixedArguments = [
    fixtureProcessor,
    ...(extractedText === undefined ? [] : [`--fixture-text=${extractedText}`]),
  ];
  const program = sandboxProgram(process.execPath, fixedArguments);
  return { pdf: program, office: program, image: program, text: program };
}
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
const contributorId = createOpaqueId();
const roomId = createOpaqueId();
let endpoint: S3TestEndpoint;
let scannerEndpoint: ClamAvTestEndpoint;
let storage: ReturnType<typeof createWebStorage>;
const owner = { kind: 'member', id: ownerId, globalRole: 'owner', roomRoles: {} } as const;
const contributor = {
  kind: 'member',
  id: contributorId,
  globalRole: 'member',
  roomRoles: { [roomId]: 'contributor' },
} as const;

beforeAll(async () => {
  await bootstrapPool.query(
    'DROP SCHEMA public CASCADE; CREATE SCHEMA public; ALTER SCHEMA public OWNER TO duefold_migration;',
  );
  await migrate(migrationPool, generatedMigrations);
  const client = await migrationPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO member (id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state) VALUES ($1,'owner-upload@example.com','owner-upload@example.com','https://issuer.example','owner-upload','owner','active'),($2,'contributor-upload@example.com','contributor-upload@example.com','https://issuer.example','contributor-upload','member','active')",
      [ownerId, contributorId],
    );
    await client.query("INSERT INTO organization (id,name) VALUES ($1,'Private Content')", [
      createOpaqueId(),
    ]);
    await client.query('SELECT create_room($1,$2,$3,$4,$5,$6)', [
      roomId,
      'Private Content',
      '',
      ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    await client.query(
      "INSERT INTO room_assignment (id,room_id,member_id,room_role) VALUES ($1,$2,$3,'contributor')",
      [createOpaqueId(), roomId, contributorId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  endpoint = await startS3TestEndpoint();
  scannerEndpoint = await startClamAvTestEndpoint({ signatureDate: new Date() });
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
  await scannerEndpoint.close();
  await endpoint.close();
  await runtimePool.end();
  await workerPool.end();
  await migrationPool.end();
  await bootstrapPool.end();
});

async function createAndUpload(
  identity: MemberIdentity = contributor,
  text = 'hello',
  displayTitle = `Investor update ${createOpaqueId()}`,
) {
  const created = await createUploadIntent({
    pool: runtimePool,
    storage,
    identity,
    input: {
      roomId,
      displayTitle,
      originalFilename: 'private-source.txt',
      declaredMediaType: 'text/plain',
      declaredSize: Buffer.byteLength(text),
      parts: [{ partNumber: 1, size: Buffer.byteLength(text) }],
    },
    now: new Date(),
  });
  const uploaded = await fetch(created.parts[0]!.url, { method: 'PUT', body: text });
  const etag = uploaded.headers.get('etag');
  if (etag === null) throw new Error('etag missing');
  const objectKeyResult = await runtimePool.query<{ object_key: string }>(
    'SELECT object_key FROM upload_intent WHERE id = $1',
    [created.intentId],
  );
  const objectKey = objectKeyResult.rows[0]?.object_key;
  if (objectKey === undefined) throw new Error('object key missing');
  return { created, etag, objectKey, displayTitle };
}

describe('multipart intent and quarantine transaction', () => {
  it('denies the forged-lease quarantine escape to the web role', async () => {
    const { created, etag } = await createAndUpload(owner, 'forgery target');
    const finalized = await finalizeUpload({
      pool: runtimePool,
      storage,
      identity: owner,
      input: {
        intentId: created.intentId,
        uploadId: created.uploadId,
        parts: [{ partNumber: 1, etag }],
      },
      now: new Date(),
    });
    const forgedJobId = createOpaqueId();
    const forgedToken = createOpaqueId();
    await expect(
      runtimePool.query(
        `INSERT INTO job_queue
         (id,job_type,idempotency_key,payload,state,attempts,lease_owner,lease_token,lease_expires_at)
         VALUES ($1::text,'document.source.validate',$2::text,jsonb_build_object('versionId',$3::text),'running',1,'attacker',$4::text,transaction_timestamp() + interval '1 hour')`,
        [forgedJobId, createOpaqueId(), finalized.versionId, forgedToken],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      runtimePool.query('SELECT record_clean_scan($1,$2,$3,$4,$5,$6,$7,$8)', [
        finalized.versionId,
        forgedJobId,
        'attacker',
        forgedToken,
        '99999',
        new Date(),
        createOpaqueId(),
        `corr_${createOpaqueId()}`,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      runtimePool.query('SELECT accept_processed_version($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [
        finalized.versionId,
        forgedJobId,
        'attacker',
        forgedToken,
        'text/plain',
        'a'.repeat(64),
        false,
        JSON.stringify([
          {
            id: createOpaqueId(),
            page_number: 1,
            object_key: `derivatives/${createOpaqueId()}/${createOpaqueId()}`,
            media_type: 'image/png',
            size_bytes: 1,
            sha256: 'b'.repeat(64),
            width: 1,
            height: 1,
            accessible_label: 'forged',
            text_layer: null,
          },
        ]),
        createOpaqueId(),
        `corr_${createOpaqueId()}`,
        0,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    expect(
      (
        await migrationPool.query<{ state: string }>(
          'SELECT state FROM document_version WHERE id = $1',
          [finalized.versionId],
        )
      ).rows[0]?.state,
    ).toBe('quarantine');
    await workerPool.query(
      `DELETE FROM job_queue
       WHERE job_type = 'document.source.validate' AND payload->>'versionId' = $1`,
      [finalized.versionId],
    );
  });

  it('creates opaque storage identity, finalizes into quarantine, audits, and queues validation', async () => {
    const { created, etag, objectKey, displayTitle } = await createAndUpload();
    expect(created).not.toHaveProperty('objectKey');
    expect(objectKey).toMatch(/^quarantine\/[A-Za-z0-9_-]{32}\/[A-Za-z0-9_-]{32}$/u);
    expect(objectKey).not.toContain('private-source');
    const finalized = await finalizeUpload({
      pool: runtimePool,
      storage,
      identity: contributor,
      input: {
        intentId: created.intentId,
        uploadId: created.uploadId,
        parts: [{ partNumber: 1, etag }],
      },
      now: new Date(),
    });
    expect(
      (
        await migrationPool.query(
          'SELECT state,original_filename,sha256 FROM document_version WHERE id = $1',
          [finalized.versionId],
        )
      ).rows[0],
    ).toEqual({ state: 'quarantine', original_filename: 'private-source.txt', sha256: null });
    expect(
      (
        await migrationPool.query<{
          document_id: string;
          display_name: string;
          parent_folder_id: string | null;
          staged_removed: boolean;
        }>(
          `SELECT document_id,display_name,parent_folder_id,staged_removed
           FROM working_structure_entry WHERE document_id=$1`,
          [finalized.documentId],
        )
      ).rows[0],
    ).toEqual({
      document_id: finalized.documentId,
      display_name: displayTitle,
      parent_folder_id: null,
      staged_removed: false,
    });
    expect(
      (
        await runtimePool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM job_queue WHERE job_type = 'document.source.validate' AND payload->>'versionId' = $1",
          [finalized.versionId],
        )
      ).rows[0]?.n,
    ).toBe(1);
    expect(
      (
        await runtimePool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM audit_event WHERE resource_id = $1 AND event_type = 'upload.finalized'",
          [finalized.versionId],
        )
      ).rows[0]?.n,
    ).toBe(1);
    await expect(
      runtimePool.query(
        `UPDATE document_version SET state='ready_for_review',
           detected_media_type=COALESCE(detected_media_type,'application/pdf'),
           sha256=COALESCE(sha256,repeat('a',64)),
           scan_signature_version=COALESCE(scan_signature_version,'99999')
         WHERE state='quarantine' AND id=$1`,
        [finalized.versionId],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const workerStorage = createWorkerStorage(
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
    const runner = new JobRunner(
      workerPool,
      new Map([
        [
          'document.source.validate',
          createSourceValidationHandler({
            pool: workerPool,
            storage: workerStorage,
            scanner: createClamAvClient({
              socket: { host: scannerEndpoint.host, port: scannerEndpoint.port },
              timeoutMilliseconds: 1_000,
            }),
            processorPrograms: fixturePrograms(),
          }),
        ],
      ]),
    );
    expect(await runner.runOne()).toBe(true);
    const validated = (
      await migrationPool.query<{
        state: string;
        detected_media_type: string;
        sha256: string;
      }>('SELECT state,detected_media_type,sha256 FROM document_version WHERE id = $1', [
        finalized.versionId,
      ])
    ).rows[0];
    expect(validated).toMatchObject({
      state: 'ready_for_review',
      detected_media_type: 'text/plain',
    });
    expect(validated?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      (
        await migrationPool.query<{ working_version_id: string | null }>(
          'SELECT working_version_id FROM document WHERE id=$1',
          [finalized.documentId],
        )
      ).rows[0]?.working_version_id,
    ).toBe(finalized.versionId);
    expect(
      (
        await migrationPool.query<{ affected_count: number }>(
          `SELECT (dry_run_bulk_publish($1,$2)->>'affectedCount')::int AS affected_count`,
          [ownerId, roomId],
        )
      ).rows[0]?.affected_count,
    ).toBeGreaterThan(0);
    const derivative = (
      await migrationPool.query<{
        object_key: string;
        sha256: string;
        media_type: string;
      }>('SELECT object_key,sha256,media_type FROM document_derivative WHERE version_id = $1', [
        finalized.versionId,
      ])
    ).rows[0];
    expect(derivative).toMatchObject({ media_type: 'image/png' });
    expect(derivative?.object_key).toMatch(
      /^derivatives\/[A-Za-z0-9_-]{32}\/[A-Za-z0-9_-]{32}$/u,
    );
    expect(derivative?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      (
        await migrationPool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM scanner_observation o
           JOIN document_scan_evidence s USING (version_id,job_id,lease_token)
           WHERE o.version_id = $1 AND o.signature_version = s.signature_version
             AND o.signatures_published_at = s.signatures_published_at`,
          [finalized.versionId],
        )
      ).rows[0]?.n,
    ).toBe(1);
    expect(
      (
        await migrationPool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM verified_derivative_object o
           JOIN document_derivative d ON d.version_id = o.version_id
             AND d.object_key = o.object_key AND d.size_bytes = o.size_bytes AND d.sha256 = o.sha256
           WHERE o.version_id = $1`,
          [finalized.versionId],
        )
      ).rows[0]?.n,
    ).toBe(1);
    await expect(
      runtimePool.query(
        'UPDATE document_derivative SET width = width + 1 WHERE version_id = $1',
        [finalized.versionId],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it.each([
    '<div>x</div>',
    '<a href=x>x</a>',
    '<table><tr><td>x</td></tr></table>',
    '</script>',
    '<!-- c -->',
    '<!-- prefix --><section>x</section>',
    '<div\nclass=x>x</div>',
  ])('keeps processing successful with inert markup-like extracted text: %s', async (value) => {
    const { created, etag } = await createAndUpload(owner, 'safe source prose');
    const finalized = await finalizeUpload({
      pool: runtimePool,
      storage,
      identity: owner,
      input: {
        intentId: created.intentId,
        uploadId: created.uploadId,
        parts: [{ partNumber: 1, etag }],
      },
      now: new Date(),
    });
    const workerStorage = createWorkerStorage(
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
    const runner = new JobRunner(
      workerPool,
      new Map([
        [
          'document.source.validate',
          createSourceValidationHandler({
            pool: workerPool,
            storage: workerStorage,
            scanner: createClamAvClient({
              socket: { host: scannerEndpoint.host, port: scannerEndpoint.port },
              timeoutMilliseconds: 1_000,
            }),
            processorPrograms: fixturePrograms(value),
          }),
        ],
      ]),
    );
    expect(await runner.runOne()).toBe(true);
    expect(
      (
        await migrationPool.query<{
          state: string;
          text_layer: unknown;
          accessible_label: string;
        }>(
          `SELECT v.state,d.text_layer,d.accessible_label FROM document_version v
           JOIN document_derivative d ON d.version_id = v.id WHERE v.id = $1`,
          [finalized.versionId],
        )
      ).rows[0],
    ).toEqual({ state: 'ready_for_review', text_layer: null, accessible_label: 'Page 1' });
  });

  it('database-quarantines malware for 30 days and cannot advance it', async () => {
    const { created, etag } = await createAndUpload(owner, 'malware bytes');
    const finalized = await finalizeUpload({
      pool: runtimePool,
      storage,
      identity: owner,
      input: {
        intentId: created.intentId,
        uploadId: created.uploadId,
        parts: [{ partNumber: 1, etag }],
      },
      now: new Date(),
    });
    const malware = await startClamAvTestEndpoint({
      signatureDate: new Date(),
      response: 'malware',
    });
    try {
      const workerStorage = createWorkerStorage(
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
      const runner = new JobRunner(
        workerPool,
        new Map([
          [
            'document.source.validate',
            createSourceValidationHandler({
              pool: workerPool,
              storage: workerStorage,
              scanner: createClamAvClient({
                socket: { host: malware.host, port: malware.port },
                timeoutMilliseconds: 1_000,
              }),
              processorPrograms: fixturePrograms(),
            }),
          ],
        ]),
      );
      expect(await runner.runOne()).toBe(true);
    } finally {
      await malware.close();
    }
    const version = (
      await migrationPool.query<{ state: string; failure_kind: string; retained_days: number }>(
        `SELECT state,failure_kind,extract(day FROM retained_until - created_at)::int AS retained_days FROM document_version WHERE id = $1`,
        [finalized.versionId],
      )
    ).rows[0];
    expect(version).toEqual({
      state: 'malware_quarantined',
      failure_kind: 'malware',
      retained_days: 30,
    });
    expect(
      (
        await migrationPool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM document_derivative WHERE version_id = $1',
          [finalized.versionId],
        )
      ).rows[0]?.n,
    ).toBe(0);
    await expect(
      runtimePool.query(
        "UPDATE document_version SET state = 'ready_for_review',detected_media_type = 'text/plain',sha256 = repeat('a',64),scan_signature_version = 'x',failure_kind = NULL,failure_code = NULL WHERE id = $1",
        [finalized.versionId],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('keeps the version quarantined when a real scanner socket returns malformed data', async () => {
    const { created, etag } = await createAndUpload(owner, 'scan outage');
    const finalized = await finalizeUpload({
      pool: runtimePool,
      storage,
      identity: owner,
      input: {
        intentId: created.intentId,
        uploadId: created.uploadId,
        parts: [{ partNumber: 1, etag }],
      },
      now: new Date(),
    });
    const malformed = await startClamAvTestEndpoint({
      signatureDate: new Date(),
      response: 'malformed',
    });
    try {
      const workerStorage = createWorkerStorage(
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
      const runner = new JobRunner(
        workerPool,
        new Map([
          [
            'document.source.validate',
            createSourceValidationHandler({
              pool: workerPool,
              storage: workerStorage,
              scanner: createClamAvClient({
                socket: { host: malformed.host, port: malformed.port },
                timeoutMilliseconds: 1_000,
              }),
              processorPrograms: fixturePrograms(),
            }),
          ],
        ]),
      );
      expect(await runner.runOne()).toBe(true);
    } finally {
      await malformed.close();
    }
    expect(
      (
        await migrationPool.query<{ state: string }>(
          'SELECT state FROM document_version WHERE id = $1',
          [finalized.versionId],
        )
      ).rows[0]?.state,
    ).toBe('quarantine');
  });

  it('rechecks current room authorization before completion and emits no version when revoked', async () => {
    const { created, etag, objectKey } = await createAndUpload();
    /* Revoked on the migration credential: migration 017 revoked direct
     * room_assignment DML from the runtime credential. What is under test is
     * unchanged -- finalization rechecks authorization against whatever rows exist. */
    await migrationPool.query(
      "UPDATE room_assignment SET state = 'revoked' WHERE room_id = $1 AND member_id = $2",
      [roomId, contributorId],
    );
    await expect(
      finalizeUpload({
        pool: runtimePool,
        storage,
        identity: contributor,
        input: {
          intentId: created.intentId,
          uploadId: created.uploadId,
          parts: [{ partNumber: 1, etag }],
        },
        now: new Date(),
      }),
    ).rejects.toThrow('UPLOAD_FORBIDDEN');
    expect(
      (
        await migrationPool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM document_version WHERE object_key = $1',
          [objectKey],
        )
      ).rows[0]?.n,
    ).toBe(0);
  });

  it('rolls document/version state back and deletes the completed object when audit persistence fails', async () => {
    const { created, etag, objectKey } = await createAndUpload(owner, 'rollback');
    await migrationPool.query(`CREATE FUNCTION fail_upload_audit_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type = 'upload.finalized' THEN RAISE EXCEPTION 'injected upload audit failure'; END IF; RETURN NEW; END $$`);
    await migrationPool.query(
      'CREATE TRIGGER fail_upload_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION fail_upload_audit_insert()',
    );
    try {
      await expect(
        finalizeUpload({
          pool: runtimePool,
          storage,
          identity: owner,
          input: {
            intentId: created.intentId,
            uploadId: created.uploadId,
            parts: [{ partNumber: 1, etag }],
          },
          now: new Date(),
        }),
      ).rejects.toThrow('injected upload audit failure');
      expect(
        (
          await migrationPool.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM document_version WHERE object_key = $1',
            [objectKey],
          )
        ).rows[0]?.n,
      ).toBe(0);
      await expect(storage.headObject(objectKey)).rejects.toThrow();
    } finally {
      await migrationPool.query('DROP TRIGGER fail_upload_audit ON audit_event');
      await migrationPool.query('DROP FUNCTION fail_upload_audit_insert()');
    }
  });

  it('treats an already-absent multipart upload as cleaned up after database retry', async () => {
    const { created } = await createAndUpload(owner, 'reap');
    await workerPool.query(
      `UPDATE upload_intent SET created_at = transaction_timestamp() - interval '25 hours',
         expires_at = transaction_timestamp() - interval '1 hour' WHERE id = $1`,
      [created.intentId],
    );
    await workerPool.query(
      `UPDATE job_queue SET available_at = transaction_timestamp()
       WHERE job_type = 'upload.multipart.reap' AND payload->>'intentId' = $1`,
      [created.intentId],
    );
    await migrationPool.query(`CREATE FUNCTION fail_expiry_audit_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type = 'upload.expired' THEN RAISE EXCEPTION 'injected expiry audit failure'; END IF; RETURN NEW; END $$`);
    await migrationPool.query(
      'CREATE TRIGGER fail_expiry_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION fail_expiry_audit_insert()',
    );
    const runner = new JobRunner(
      workerPool,
      new Map([
        ['upload.multipart.reap', createMultipartReapHandler({ pool: workerPool, storage })],
      ]),
    );
    try {
      expect(await runner.runOne()).toBe(true);
      expect(
        (
          await runtimePool.query<{ state: string }>(
            'SELECT state FROM upload_intent WHERE id = $1',
            [created.intentId],
          )
        ).rows[0]?.state,
      ).toBe('open');
    } finally {
      await migrationPool.query('DROP TRIGGER fail_expiry_audit ON audit_event');
      await migrationPool.query('DROP FUNCTION fail_expiry_audit_insert()');
    }
    await workerPool.query(
      `UPDATE job_queue SET available_at = transaction_timestamp()
       WHERE job_type = 'upload.multipart.reap' AND payload->>'intentId' = $1`,
      [created.intentId],
    );
    expect(await runner.runOne()).toBe(true);
    expect(
      (
        await runtimePool.query<{ state: string }>(
          'SELECT state FROM upload_intent WHERE id = $1',
          [created.intentId],
        )
      ).rows[0]?.state,
    ).toBe('expired');
    expect(
      (
        await runtimePool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM audit_event WHERE event_type = 'upload.expired' AND resource_id = $1",
          [created.intentId],
        )
      ).rows[0]?.count,
    ).toBe(1);
  });

  it('enforces the source size boundary in the server intent path before storage work', async () => {
    const input = {
      roomId,
      displayTitle: 'Limit',
      originalFilename: 'limit.txt',
      declaredMediaType: 'text/plain',
      parts: Array.from({ length: 50 }, (_, index) => ({
        partNumber: index + 1,
        size: 5 * 1024 * 1024,
      })),
    };
    const atLimit = await createUploadIntent({
      pool: runtimePool,
      storage,
      identity: owner,
      input: { ...input, declaredSize: MAX_SOURCE_BYTES },
      now: new Date(),
    });
    expect(atLimit).not.toHaveProperty('objectKey');
    const createMultipart = vi.fn<WebStorage['createMultipart']>();
    const untouchedStorage: WebStorage = {
      checksumSupport: false,
      checkReady: () => Promise.resolve(),
      createMultipart,
      presignPart: () => Promise.reject(new Error('STORAGE_TOUCHED')),
      completeMultipart: () => Promise.reject(new Error('STORAGE_TOUCHED')),
      abortMultipart: () => Promise.reject(new Error('STORAGE_TOUCHED')),
      headObject: () => Promise.reject(new Error('STORAGE_TOUCHED')),
      deleteObject: () => Promise.reject(new Error('STORAGE_TOUCHED')),
    };
    await expect(
      createUploadIntent({
        pool: runtimePool,
        storage: untouchedStorage,
        identity: owner,
        input: { ...input, declaredSize: MAX_SOURCE_BYTES + 1 },
        now: new Date(),
      }),
    ).rejects.toThrow('SOURCE_SIZE_REJECTED');
    expect(createMultipart).not.toHaveBeenCalled();
  });

  it('prevents runtime update or delete after a source version is accepted', async () => {
    const documentId = createOpaqueId();
    const versionId = createOpaqueId();
    await runtimePool.query(
      "INSERT INTO document (id,room_id,display_title,created_by) VALUES ($1,$2,'Immutable',$3)",
      [documentId, roomId, ownerId],
    );
    await migrationPool.query(
      "INSERT INTO document_version (id,document_id,original_filename,object_key,declared_media_type,detected_media_type,size_bytes,sha256,state) VALUES ($1,$2,'source.txt',$3,'text/plain','text/plain',1,$4,'source_validated')",
      [
        versionId,
        documentId,
        `quarantine/${createOpaqueId()}/${createOpaqueId()}`,
        'a'.repeat(64),
      ],
    );
    for (const update of [
      "sha256 = repeat('b', 64)",
      'size_bytes = 2',
      "detected_media_type = 'text/csv'",
    ])
      await expect(
        runtimePool.query(`UPDATE document_version SET ${update} WHERE id = $1`, [versionId]),
      ).rejects.toMatchObject({ code: '42501' });
    await expect(
      runtimePool.query('DELETE FROM document_version WHERE id = $1', [versionId]),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
