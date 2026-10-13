import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { generatedMigrations } from '../../.duefold/generated/migrations.ts';
import { migrate } from '../../modules/core-security/src/db/migrate.ts';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import { createUploadIntent } from '../../modules/rooms-documents/src/uploads.ts';
import { requestManualProcessingRetry } from '../../modules/rooms-documents/src/processing-retry.ts';
import { deleteFailedSource } from '../../modules/rooms-documents/src/failed-source-deletion.ts';
import type { WebStorage } from '../../modules/rooms-documents/src/storage/s3-compatible.ts';

const bootstrapPool = new Pool({
  host: '/var/run/postgresql',
  database: 'duefold_test',
});
const migrationPool = new Pool({
  connectionString: process.env['DUEFOLD_TEST_MIGRATION_DATABASE_URL'],
});
const runtimePool = new Pool({ connectionString: process.env['DUEFOLD_TEST_DATABASE_URL'] });
const roomId = createOpaqueId();
const ownerId = createOpaqueId();
const adminId = createOpaqueId();
const memberId = createOpaqueId();
const managerId = createOpaqueId();
const contributorId = createOpaqueId();
let storageCalls = 0;
const storage: WebStorage = {
  checksumSupport: false,
  checkReady: () => Promise.resolve(),
  createMultipart: ({ key }) => {
    storageCalls += 1;
    return Promise.resolve({ key, uploadId: createOpaqueId() });
  },
  presignPart: () => Promise.resolve('https://upload.invalid'),
  completeMultipart: () => Promise.resolve(),
  abortMultipart: () => Promise.resolve(),
  headObject: () => Promise.reject(new Error('unused')),
  deleteObject: () => Promise.resolve(),
};
beforeAll(async () => {
  await bootstrapPool.query(
    'DROP SCHEMA public CASCADE; CREATE SCHEMA public; ALTER SCHEMA public OWNER TO duefold_migration;',
  );
  await migrate(migrationPool, generatedMigrations);
  const client = await migrationPool.connect();
  try {
    await client.query('BEGIN');
    const members = [
      [ownerId, 'authz-owner@example.com', 'owner'],
      [adminId, 'authz-admin@example.com', 'admin'],
      [memberId, 'authz-member@example.com', 'member'],
      [managerId, 'authz-manager@example.com', 'member'],
      [contributorId, 'authz-contributor@example.com', 'member'],
    ] as const;
    for (const [id, email, role] of members)
      await client.query(
        "INSERT INTO member (id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state) VALUES ($1,$2,$2,'https://issuer.example',$1,$3,'active')",
        [id, email, role],
      );
    await client.query("INSERT INTO organization (id,name) VALUES ($1,'Upload Authz')", [
      createOpaqueId(),
    ]);
    await client.query('SELECT create_room($1,$2,$3,$4,$5,$6)', [
      roomId,
      'Upload Authz',
      '',
      ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    await client.query(
      "INSERT INTO room_assignment (id,room_id,member_id,room_role) VALUES ($1,$2,$3,'manager'),($4,$2,$5,'contributor')",
      [createOpaqueId(), roomId, managerId, createOpaqueId(), contributorId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});
afterAll(async () => {
  await runtimePool.end();
  await migrationPool.end();
  await bootstrapPool.end();
});
function identity(
  id: string,
  globalRole: 'owner' | 'admin' | 'member',
  roomRole?: 'manager' | 'contributor',
) {
  return {
    kind: 'member',
    id,
    globalRole,
    roomRoles: roomRole === undefined ? {} : { [roomId]: roomRole },
  } as const;
}
async function attempt(principal: ReturnType<typeof identity>): Promise<boolean> {
  try {
    await createUploadIntent({
      pool: runtimePool,
      storage,
      identity: principal,
      input: {
        roomId,
        displayTitle: 'Authz',
        originalFilename: 'authz.txt',
        declaredMediaType: 'text/plain',
        declaredSize: 1,
        parts: [{ partNumber: 1, size: 1 }],
      },
      now: new Date(),
    });
    return true;
  } catch (error) {
    if (error instanceof Error && error.message === 'UPLOAD_FORBIDDEN') return false;
    throw error;
  }
}
describe('upload authorization matrix', () => {
  it.each([
    ['owner', identity(ownerId, 'owner'), true],
    ['admin', identity(adminId, 'admin'), true],
    ['unassigned member', identity(memberId, 'member'), false],
    ['manager', identity(managerId, 'member', 'manager'), true],
    ['contributor', identity(contributorId, 'member', 'contributor'), true],
  ] as const)('%s intent authorization => %s', async (_label, principal, allowed) => {
    expect(await attempt(principal)).toBe(allowed);
  });
  /*
   * XLSX/ODS are disabled pending workbook-adapter qualification.
   * The security-bearing property is that a disabled format
   * is refused BEFORE any storage work, so a disabled upload can never allocate
   * a multipart upload. This assertion follows the release policy; when the
   * adapter is qualified and the formats are enabled, invert it back.
   */
  it.each([
    [
      'model.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' as const,
    ],
    ['model.ods', 'application/vnd.oasis.opendocument.spreadsheet' as const],
  ])(
    'refuses disabled office format %s before touching storage',
    async (filename, mediaType) => {
      const createMultipart = vi.fn<WebStorage['createMultipart']>(({ key }) =>
        Promise.resolve({ key, uploadId: createOpaqueId() }),
      );
      await expect(
        createUploadIntent({
          pool: runtimePool,
          storage: { ...storage, createMultipart },
          identity: identity(ownerId, 'owner'),
          input: {
            roomId,
            displayTitle: 'Workbook',
            originalFilename: filename,
            declaredMediaType: mediaType,
            declaredSize: 1,
            parts: [{ partNumber: 1, size: 1 }],
          },
          now: new Date(),
        }),
      ).rejects.toThrow('FORMAT_DISABLED_BY_RELEASE');
      expect(createMultipart).not.toHaveBeenCalled();
    },
  );
  it('denies before touching storage when the room is archived', async () => {
    const selectedRoom = await migrationPool.query<{ revision: number }>(
      'SELECT revision FROM room WHERE id = $1',
      [roomId],
    );
    await migrationPool.query('SELECT change_room_state($1,$2,$3,$4,$5,$6)', [
      roomId,
      'archived',
      ownerId,
      selectedRoom.rows[0]?.revision,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    const before = storageCalls;
    expect(await attempt(identity(ownerId, 'owner'))).toBe(false);
    expect(storageCalls).toBe(before);
  });
});

describe('manual processing retry authorization matrix', () => {
  async function failedVersion(): Promise<string> {
    const documentId = createOpaqueId();
    const versionId = createOpaqueId();
    const selectedRoom = await migrationPool.query<{ revision: number }>(
      'SELECT revision FROM room WHERE id = $1',
      [roomId],
    );
    await migrationPool.query('SELECT change_room_state($1,$2,$3,$4,$5,$6)', [
      roomId,
      'draft',
      ownerId,
      selectedRoom.rows[0]?.revision,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    await migrationPool.query(
      "INSERT INTO document (id,room_id,display_title,created_by) VALUES ($1,$2,'Retry',$3)",
      [documentId, roomId, ownerId],
    );
    await migrationPool.query(
      `INSERT INTO document_version
       (id,document_id,original_filename,object_key,declared_media_type,size_bytes,state,failure_kind,failure_code,retained_until)
       VALUES ($1,$2,'failed.txt',$3,'text/plain',1,'processing_failed','transient','SCANNER_UNAVAILABLE',transaction_timestamp() + interval '7 days')`,
      [versionId, documentId, `quarantine/${createOpaqueId()}/${createOpaqueId()}`],
    );
    return versionId;
  }
  it.each([
    ['owner', identity(ownerId, 'owner'), true],
    ['admin', identity(adminId, 'admin'), true],
    ['unassigned member', identity(memberId, 'member'), false],
    ['manager', identity(managerId, 'member', 'manager'), true],
    ['contributor', identity(contributorId, 'member', 'contributor'), true],
  ] as const)('%s retry authorization => %s', async (_label, principal, allowed) => {
    const versionId = await failedVersion();
    const promise = requestManualProcessingRetry({
      pool: runtimePool,
      identity: principal,
      versionId,
    });
    if (allowed) {
      await expect(promise).resolves.toBeUndefined();
      expect(
        (
          await migrationPool.query<{ manual_retry_count: number }>(
            'SELECT manual_retry_count FROM document_version WHERE id = $1',
            [versionId],
          )
        ).rows[0]?.manual_retry_count,
      ).toBe(1);
      await expect(
        requestManualProcessingRetry({ pool: runtimePool, identity: principal, versionId }),
      ).rejects.toThrow('MANUAL_RETRY_FORBIDDEN');
    } else await expect(promise).rejects.toThrow('MANUAL_RETRY_FORBIDDEN');
  });
  it('denies deterministic and malware failures regardless of member authority', async () => {
    for (const [state, kind, days] of [
      ['rejected', 'deterministic', 7],
      ['malware_quarantined', 'malware', 30],
    ] as const) {
      const documentId = createOpaqueId();
      const versionId = createOpaqueId();
      await migrationPool.query(
        "INSERT INTO document (id,room_id,display_title,created_by) VALUES ($1,$2,'No retry',$3)",
        [documentId, roomId, ownerId],
      );
      await migrationPool.query(
        `INSERT INTO document_version (id,document_id,original_filename,object_key,declared_media_type,size_bytes,state,failure_kind,failure_code,retained_until) VALUES ($1,$2,'bad.txt',$3,'text/plain',1,$4,$5,'SOURCE_REJECTED',transaction_timestamp() + ($6 * interval '1 day'))`,
        [
          versionId,
          documentId,
          `quarantine/${createOpaqueId()}/${createOpaqueId()}`,
          state,
          kind,
          days,
        ],
      );
      await expect(
        requestManualProcessingRetry({
          pool: runtimePool,
          identity: identity(ownerId, 'owner'),
          versionId,
        }),
      ).rejects.toThrow('MANUAL_RETRY_FORBIDDEN');
    }
  });
  it('commits deletion-pending audit before storage and remains safely retryable on storage failure', async () => {
    const versionId = await failedVersion();
    const failingStorage: WebStorage = {
      ...storage,
      deleteObject: () => Promise.reject(new Error('injected storage failure')),
    };
    await expect(
      deleteFailedSource({
        pool: runtimePool,
        storage: failingStorage,
        identity: identity(ownerId, 'owner'),
        versionId,
      }),
    ).rejects.toThrow('injected storage failure');
    expect(
      (
        await migrationPool.query<{ state: string }>(
          'SELECT state FROM document_version WHERE id = $1',
          [versionId],
        )
      ).rows[0]?.state,
    ).toBe('failed_source_deletion_pending');
    expect(
      (
        await runtimePool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM audit_event WHERE resource_id = $1 AND reason_code = 'FAILED_SOURCE_DELETION_PENDING'",
          [versionId],
        )
      ).rows[0]?.n,
    ).toBe(1);
    await expect(
      deleteFailedSource({
        pool: runtimePool,
        storage,
        identity: identity(ownerId, 'owner'),
        versionId,
      }),
    ).resolves.toBeUndefined();
  });
  it('rolls back deletion-pending state when its audit insert fails', async () => {
    const versionId = await failedVersion();
    await migrationPool.query(`CREATE FUNCTION fail_retention_audit_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN IF NEW.reason_code = 'FAILED_SOURCE_DELETION_PENDING' THEN RAISE EXCEPTION 'injected retention audit failure'; END IF; RETURN NEW; END $$`);
    await migrationPool.query(
      'CREATE TRIGGER fail_retention_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION fail_retention_audit_insert()',
    );
    try {
      await expect(
        deleteFailedSource({
          pool: runtimePool,
          storage,
          identity: identity(ownerId, 'owner'),
          versionId,
        }),
      ).rejects.toThrow('injected retention audit failure');
      expect(
        (
          await migrationPool.query<{ state: string }>(
            'SELECT state FROM document_version WHERE id = $1',
            [versionId],
          )
        ).rows[0]?.state,
      ).toBe('processing_failed');
    } finally {
      await migrationPool.query('DROP TRIGGER fail_retention_audit ON audit_event');
      await migrationPool.query('DROP FUNCTION fail_retention_audit_insert()');
    }
  });
  it.each([
    ['owner', identity(ownerId, 'owner'), true],
    ['admin', identity(adminId, 'admin'), true],
    ['unassigned member', identity(memberId, 'member'), false],
    ['manager', identity(managerId, 'member', 'manager'), true],
    ['contributor', identity(contributorId, 'member', 'contributor'), true],
  ] as const)(
    '%s failed-source deletion authorization => %s',
    async (_label, principal, allowed) => {
      const versionId = await failedVersion();
      const promise = deleteFailedSource({
        pool: runtimePool,
        storage,
        identity: principal,
        versionId,
      });
      if (allowed) {
        await expect(promise).resolves.toBeUndefined();
        expect(
          (
            await migrationPool.query<{ state: string }>(
              'SELECT state FROM document_version WHERE id = $1',
              [versionId],
            )
          ).rows[0]?.state,
        ).toBe('failed_source_deleted');
      } else await expect(promise).rejects.toThrow('FAILED_SOURCE_DELETE_FORBIDDEN');
    },
  );

  /*
   * The web role can read derivative object keys, so a generic enqueue boundary
   * was a privilege-escalation path: forged `document.derivative.cleanup` work
   * made the worker delete a live derivative object. The web role may only
   * enqueue job types a request path legitimately originates.
   */
  it('denies the web role enqueueing worker-internal job types', async () => {
    for (const jobType of [
      'document.derivative.cleanup',
      'document.retention.sweep',
      'anything.else',
    ])
      await expect(
        runtimePool.query('SELECT enqueue_job($1,$2,$3,$4::jsonb,transaction_timestamp(),5)', [
          createOpaqueId(),
          jobType,
          `atk-${createOpaqueId()}`,
          JSON.stringify({ objectKey: 'derivative/forged' }),
        ]),
      ).rejects.toThrow('job type not enqueueable by this role');
    // The three request-originated types must still work, or login breaks.
    for (const jobType of [
      'auth.otp.deliver',
      'upload.multipart.reap',
      'document.source.validate',
    ])
      await expect(
        runtimePool.query('SELECT enqueue_job($1,$2,$3,$4::jsonb,transaction_timestamp(),5)', [
          createOpaqueId(),
          jobType,
          `ok-${createOpaqueId()}`,
          JSON.stringify({ probe: true }),
        ]),
      ).resolves.toBeDefined();
  });
});

describe('repeated processing failure', () => {
  async function leaseValidation(versionId: string): Promise<{ id: string; token: string }> {
    const owner = 'retry-test-owner';
    const token = createOpaqueId();
    const job = (
      await migrationPool.query<{ id: string }>(
        `UPDATE job_queue SET state='running',attempts=attempts+1,lease_owner=$2,lease_token=$3,
           lease_expires_at=transaction_timestamp()+interval '2 minutes'
         WHERE job_type='document.source.validate' AND payload->>'versionId'=$1 AND state='pending'
         RETURNING id`,
        [versionId, owner, token],
      )
    ).rows[0];
    if (job === undefined) throw new Error('VALIDATION_JOB_ABSENT');
    return { id: job.id, token };
  }
  async function failTransiently(versionId: string): Promise<void> {
    const job = await leaseValidation(versionId);
    await migrationPool.query(
      "SELECT fail_document_processing($1,$2,'retry-test-owner',$3,'processing_failed','transient','SCANNER_UNAVAILABLE',7,$4,$5,$6)",
      [versionId, job.id, job.token, createOpaqueId(), createCorrelationId(), createOpaqueId()],
    );
  }

  async function failedVersion(): Promise<string> {
    const documentId = createOpaqueId();
    const versionId = createOpaqueId();
    const room = await migrationPool.query<{ revision: number; state: string }>(
      'SELECT revision,state FROM room WHERE id = $1',
      [roomId],
    );
    if (room.rows[0]?.state !== 'draft')
      await migrationPool.query('SELECT change_room_state($1,$2,$3,$4,$5,$6)', [
        roomId,
        'draft',
        ownerId,
        room.rows[0]?.revision,
        createOpaqueId(),
        createCorrelationId(),
      ]);
    await migrationPool.query(
      "INSERT INTO document (id,room_id,display_title,created_by) VALUES ($1,$2,'Fails twice',$3)",
      [documentId, roomId, ownerId],
    );
    await migrationPool.query(
      `INSERT INTO document_version (id,document_id,original_filename,object_key,declared_media_type,size_bytes)
       VALUES ($1,$2,'twice.txt',$3,'text/plain',1)`,
      [versionId, documentId, `quarantine/${createOpaqueId()}/${createOpaqueId()}`],
    );
    await migrationPool.query(
      "INSERT INTO job_queue (id,job_type,idempotency_key,payload) VALUES ($1,'document.source.validate',$2,jsonb_build_object('versionId',$3::text))",
      [createOpaqueId(), `validate:${versionId}`, versionId],
    );
    await failTransiently(versionId);
    return versionId;
  }
  async function retryAndFailAgain(versionId: string): Promise<void> {
    await requestManualProcessingRetry({
      pool: runtimePool,
      identity: identity(ownerId, 'owner'),
      versionId,
    });
    await failTransiently(versionId);
    const version = (
      await migrationPool.query<{ state: string; retained_until: Date }>(
        'SELECT state,retained_until FROM document_version WHERE id = $1',
        [versionId],
      )
    ).rows[0];
    expect(version?.state).toBe('processing_failed');
    const sweeps = await migrationPool.query<{
      state: string;
      available_at: Date;
      attempts: number;
    }>(
      "SELECT state,available_at,attempts FROM job_queue WHERE job_type = 'document.retention.sweep' AND payload->>'versionId' = $1",
      [versionId],
    );
    expect(sweeps.rows).toEqual([
      { state: 'pending', available_at: version?.retained_until, attempts: 0 },
    ]);
  }

  it('fails again after a manual retry and keeps one re-armed retention sweep', async () => {
    await retryAndFailAgain(await failedVersion());
  });

  it('replaces a finished retention sweep when a manual retry fails again', async () => {
    const versionId = await failedVersion();
    await migrationPool.query(
      `UPDATE job_queue SET state='running',attempts=1,lease_owner='sweep-owner',lease_token=$2,
         lease_expires_at=transaction_timestamp()+interval '2 minutes'
       WHERE idempotency_key = 'retention:' || $1`,
      [versionId, createOpaqueId()],
    );
    await migrationPool.query(
      `UPDATE job_queue SET state='succeeded',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
       WHERE idempotency_key = 'retention:' || $1`,
      [versionId],
    );
    await retryAndFailAgain(versionId);
  });

  it('records lease-held and exhausted failures through one helper no app role can call', async () => {
    const helper = 'record_document_processing_failure(text,timestamptz,text,text,text,text)';
    const callers = await migrationPool.query<{ proname: string }>(
      `SELECT proname FROM pg_proc WHERE proname IN
         ('fail_document_processing','fail_exhausted_document_processing')
         AND prosrc LIKE '%record_document_processing_failure(%'`,
    );
    expect(callers.rows.map(({ proname }) => proname).toSorted()).toEqual([
      'fail_document_processing',
      'fail_exhausted_document_processing',
    ]);
    for (const role of ['duefold_runtime', 'duefold_authenticator', 'duefold_worker'])
      expect(
        (
          await migrationPool.query<{ v: boolean }>(
            "SELECT has_function_privilege($1,$2,'EXECUTE') v",
            [role, helper],
          )
        ).rows[0]?.v,
        role,
      ).toBe(false);
  });
});
