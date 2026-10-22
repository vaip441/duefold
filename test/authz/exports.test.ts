import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import { generatedMigrations } from '../../.duefold/generated/migrations.ts';
import { migrate } from '../../modules/core-security/src/db/migrate.ts';
import {
  downloadExportOnce,
  generateExportJob,
  requestExport,
  preflightExport,
  type ExportStorage,
} from '../../modules/rooms-documents/src/exports.ts';
import { MAX_MULTIPART_PART_BYTES } from '../../modules/rooms-documents/src/resource-policy.ts';
import { multipartParts } from '../../modules/rooms-documents/src/storage/s3-compatible.ts';

const bootstrapPool = new Pool({
  host: '/var/run/postgresql',
  database: 'duefold_test',
});
const migrationPool = new Pool({
  connectionString: process.env['DUEFOLD_TEST_MIGRATION_DATABASE_URL'],
});
const runtimePool = new Pool({ connectionString: process.env['DUEFOLD_TEST_DATABASE_URL'] });
const authPool = new Pool({ connectionString: process.env['DUEFOLD_TEST_AUTH_DATABASE_URL'] });
const workerPool = new Pool({
  connectionString: process.env['DUEFOLD_TEST_WORKER_DATABASE_URL'],
});
const ownerId = createOpaqueId();
const managerId = createOpaqueId();
const secondManagerId = createOpaqueId();
const contributorId = createOpaqueId();
const roomId = createOpaqueId();
const documentId = createOpaqueId();
const objectMap = new Map<string, Uint8Array>();
/*
 * Tracks how many source bodies are open at once. Building the ZIP entry list by
 * awaiting every storage.streamSource opened up to 1,000 provider connections
 * before the archive consumed the first, so this records the peak to prove the
 * entries are opened lazily, one at a time.
 */
const sourceOpens = { active: 0, peak: 0 };
const deleted: string[] = [];
const storage: ExportStorage = {
  async putStream(input) {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of input.stream) {
      chunks.push(chunk);
      size += chunk.byteLength;
    }
    objectMap.set(input.key, Buffer.concat(chunks));
    return size;
  },
  streamSource(key) {
    const value = objectMap.get(key);
    if (!value) return Promise.reject(new Error('absent'));
    sourceOpens.active += 1;
    sourceOpens.peak = Math.max(sourceOpens.peak, sourceOpens.active);
    return Promise.resolve({
      async *[Symbol.asyncIterator]() {
        try {
          await Promise.resolve();
          yield value;
        } finally {
          sourceOpens.active -= 1;
        }
      },
    });
  },
  streamExport(key) {
    const value = objectMap.get(key);
    if (!value) return Promise.reject(new Error('absent'));
    return Promise.resolve({
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        yield value;
      },
    });
  },
  delete(key) {
    objectMap.delete(key);
    deleted.push(key);
    return Promise.resolve();
  },
};
async function leaseExportJob(exportId: string): Promise<{
  readonly jobId: string;
  readonly leaseOwner: string;
  readonly leaseToken: string;
}> {
  const leaseOwner = createOpaqueId();
  const leaseToken = createOpaqueId();
  const job = (
    await migrationPool.query<{ id: string }>(
      `UPDATE job_queue SET state='running',attempts=attempts+1,lease_owner=$2,lease_token=$3,
        lease_expires_at=statement_timestamp()+interval '2 minutes'
       WHERE job_type='export.generate' AND payload->>'exportId'=$1 RETURNING id`,
      [exportId, leaseOwner, leaseToken],
    )
  ).rows[0];
  if (job === undefined) throw new Error('EXPORT_JOB_FIXTURE_ABSENT');
  return { jobId: job.id, leaseOwner, leaseToken };
}
async function generateExport(
  input: Parameters<typeof requestExport>[0] & { readonly storage: ExportStorage },
): Promise<Awaited<ReturnType<typeof requestExport>>> {
  const requested = await requestExport(input);
  await generateExportJob({
    pool: workerPool,
    storage: input.storage,
    exportId: requested.exportId,
    ...(await leaseExportJob(requested.exportId)),
  });
  return requested;
}
async function bytes(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const identity = (id: string, at: Date) => ({
  kind: 'member' as const,
  id,
  globalRole: 'member' as const,
  roomRoles: {
    [roomId]: id === contributorId ? ('contributor' as const) : ('manager' as const),
  },
  oidcAuthenticatedAt: at,
});
function audit(): readonly [string, string] {
  return [createOpaqueId(), createCorrelationId()];
}

beforeAll(async () => {
  await bootstrapPool.query(
    'DROP SCHEMA public CASCADE; CREATE SCHEMA public; ALTER SCHEMA public OWNER TO duefold_migration;',
  );
  await migrate(migrationPool, generatedMigrations);
  const client = await migrationPool.connect();
  try {
    await client.query('BEGIN');
    for (const [id, email, role] of [
      [ownerId, 'export-owner@example.test', 'owner'],
      [managerId, 'export-manager@example.test', 'member'],
      [secondManagerId, 'export-manager-two@example.test', 'member'],
      [contributorId, 'export-contributor@example.test', 'member'],
    ] as const)
      await client.query(
        "INSERT INTO member(id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state) VALUES($1,$2,$2,'https://issuer.example',$1,$3,'active')",
        [id, email, role],
      );
    await client.query("INSERT INTO organization(id,name) VALUES($1,'Exports')", [
      createOpaqueId(),
    ]);
    await client.query('SELECT create_room($1,$2,$3,$4,$5,$6)', [
      roomId,
      'Populated export room',
      'Distinct description',
      ownerId,
      ...audit(),
    ]);
    await client.query(
      "INSERT INTO room_assignment(id,room_id,member_id,room_role) VALUES($1,$2,$3,'manager'),($4,$2,$5,'manager'),($6,$2,$7,'contributor')",
      [
        createOpaqueId(),
        roomId,
        managerId,
        createOpaqueId(),
        secondManagerId,
        createOpaqueId(),
        contributorId,
      ],
    );
    await client.query(
      "INSERT INTO document(id,room_id,display_title,created_by) VALUES($1,$2,'Distinct export document',$3)",
      [documentId, roomId, ownerId],
    );
    await client.query(
      "INSERT INTO audit_event(id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,result,reason_code,correlation_id) VALUES($1,'room.metadata','member',$2,$3,'document',$4,'success','FIXTURE',$5)",
      [...audit().slice(0, 1), ownerId, roomId, documentId, audit()[1]],
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
  await Promise.all([
    runtimePool.end(),
    authPool.end(),
    workerPool.end(),
    migrationPool.end(),
    bootstrapPool.end(),
  ]);
});

describe('private export lifecycle', () => {
  it('reconciles a populated audit export, deletes the object, and refuses the second download', async () => {
    const fresh = new Date();
    const generated = await generateExport({
      pool: runtimePool,
      storage,
      identity: identity(managerId, fresh),
      roomId,
      preset: 'room-index-audit',
      selectedDocumentIds: [],
      includeOriginals: false,
      now: fresh,
    });
    expect(generated.preflight.originalsIncluded).toBe(false);
    expect(generated.preflight.retentionEffect).toContain('one download');
    const row = (
      await migrationPool.query<{ object_key: string }>(
        'SELECT object_key FROM export_request WHERE id=$1',
        [generated.exportId],
      )
    ).rows[0];
    expect(row).toBeDefined();
    const downloaded = await downloadExportOnce({
      pool: runtimePool,
      storage,
      identity: identity(managerId, fresh),
      exportId: generated.exportId,
    });
    const parsed = JSON.parse((await bytes(downloaded.stream)).toString('utf8')) as {
      preset: string;
      audit: unknown[];
    };
    expect(parsed.preset).toBe('room-index-audit');
    expect(parsed.audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: 'room.metadata', result: 'success' }),
      ]),
    );
    expect(objectMap.has(row?.object_key ?? '')).toBe(true);
    const deletedRow = (
      await migrationPool.query<{ state: string; deleted_at: Date | null }>(
        'SELECT state,deleted_at FROM export_request WHERE id=$1',
        [generated.exportId],
      )
    ).rows[0];
    expect(deletedRow?.state).toBe('deletion_pending');
    expect(deletedRow?.deleted_at).toBeNull();
    await expect(
      downloadExportOnce({
        pool: runtimePool,
        storage,
        identity: identity(managerId, fresh),
        exportId: generated.exportId,
      }),
    ).rejects.toThrow('EXPORT_DOWNLOAD_FORBIDDEN');
  });

  it('reconciles selected-document ZIP manifest without originals or private source metadata', async () => {
    const fresh = new Date();
    const generated = await generateExport({
      pool: runtimePool,
      storage,
      identity: identity(managerId, fresh),
      roomId,
      preset: 'selected-documents',
      selectedDocumentIds: [documentId],
      includeOriginals: false,
      now: fresh,
    });
    expect(generated.preflight).toMatchObject({ fileCount: 1, originalsIncluded: false });
    const downloaded = await downloadExportOnce({
      pool: runtimePool,
      storage,
      identity: identity(managerId, fresh),
      exportId: generated.exportId,
    });
    const archive = await bytes(downloaded.stream);
    expect(downloaded.contentType).toBe('application/zip');
    expect(archive.readUInt32LE(0)).toBe(0x04034b50);
    expect(archive.toString('utf8')).toContain('manifest.json');
    expect(archive.toString('utf8')).toContain(documentId);
    expect(archive.toString('utf8')).toContain('Distinct export document');
    expect(archive.toString('utf8')).not.toContain('quarantine/');
    expect(archive.toString('utf8')).not.toContain('.pdf');
  });

  it('rejects stale OIDC and Contributor while fresh Manager succeeds in the same populated room', async () => {
    const now = new Date();
    await expect(
      generateExport({
        pool: runtimePool,
        storage,
        identity: identity(managerId, new Date(now.getTime() - 16 * 60_000)),
        roomId,
        preset: 'participant-access',
        selectedDocumentIds: [],
        includeOriginals: false,
        now,
      }),
    ).rejects.toThrow('FRESH_OIDC_REQUIRED');
    await expect(
      preflightExport({
        pool: runtimePool,
        identity: identity(contributorId, now),
        roomId,
        preset: 'participant-access',
        selectedDocumentIds: [],
        includeOriginals: false,
      }),
    ).rejects.toMatchObject({ code: '42501' });
    const allowed = await generateExport({
      pool: runtimePool,
      storage,
      identity: identity(managerId, now),
      roomId,
      preset: 'participant-access',
      selectedDocumentIds: [],
      includeOriginals: false,
      now,
    });
    expect(allowed.preflight.piiCategories).toEqual([
      'viewer identity',
      'access grants',
      'expiry',
    ]);
    await expect(
      downloadExportOnce({
        pool: runtimePool,
        storage,
        identity: identity(managerId, new Date(now.getTime() - 16 * 60_000)),
        exportId: allowed.exportId,
      }),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      downloadExportOnce({
        pool: runtimePool,
        storage,
        identity: identity(secondManagerId, now),
        exportId: allowed.exportId,
      }),
    ).rejects.toThrow('EXPORT_DOWNLOAD_FORBIDDEN');
    await expect(
      downloadExportOnce({
        pool: runtimePool,
        storage,
        identity: identity(contributorId, now),
        exportId: allowed.exportId,
      }),
    ).rejects.toThrow('EXPORT_DOWNLOAD_FORBIDDEN');
    const downloaded = await downloadExportOnce({
      pool: runtimePool,
      storage,
      identity: identity(managerId, now),
      exportId: allowed.exportId,
    });
    expect(downloaded).toMatchObject({ contentType: 'application/json' });
    const objectKey = (
      await migrationPool.query<{ object_key: string }>(
        'SELECT object_key FROM export_request WHERE id=$1',
        [allowed.exportId],
      )
    ).rows[0]?.object_key;
    expect(objectKey).toBeDefined();
    const file = (await bytes(downloaded.stream)).toString('utf8');
    expect(JSON.parse(file)).toMatchObject({ preset: 'participant-access', roomId });
    expect(file).not.toContain(objectKey);
  });

  it('enforces the exact server-side one-hour boundary without rejecting early', async () => {
    const id = createOpaqueId();
    const fresh = new Date();
    await runtimePool.query(
      'SELECT create_export_request($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [
        id,
        managerId,
        roomId,
        'room-index-audit',
        [],
        false,
        fresh,
        `exports/${createOpaqueId()}/${createOpaqueId()}`,
        'application/json',
        createOpaqueId(),
        ...audit(),
      ],
    );
    await migrationPool.query(
      "UPDATE export_request SET state='ready',size_bytes=1,expires_at=statement_timestamp()+interval '2 seconds' WHERE id=$1",
      [id],
    );
    expect(
      (
        await runtimePool.query('SELECT * FROM claim_export_download($1,$2,$3,$4,$5)', [
          id,
          managerId,
          fresh,
          ...audit(),
        ])
      ).rowCount,
    ).toBe(1);
    await migrationPool.query(
      "UPDATE export_request SET state='ready',consumed_at=NULL,expires_at=statement_timestamp()-interval '1 millisecond' WHERE id=$1",
      [id],
    );
    expect(
      (
        await runtimePool.query('SELECT * FROM claim_export_download($1,$2,$3,$4,$5)', [
          id,
          managerId,
          fresh,
          ...audit(),
        ])
      ).rowCount,
    ).toBe(0);
  });

  it('keeps export tables private and function arity aligned', async () => {
    for (const role of ['duefold_runtime', 'duefold_authenticator', 'duefold_worker'])
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
        expect(
          (
            await migrationPool.query<{ v: boolean }>(
              'SELECT has_table_privilege($1,$2,$3) v',
              [role, 'export_request', privilege],
            )
          ).rows[0]?.v,
          `${role} ${privilege}`,
        ).toBe(false);
    expect(
      (
        await migrationPool.query<{ n: number }>(
          "SELECT pronargs::int n FROM pg_proc WHERE proname='create_export_request'",
        )
      ).rows[0]?.n,
    ).toBe(12);
    expect(
      (
        await migrationPool.query<{ n: number }>(
          "SELECT pronargs::int n FROM pg_proc WHERE proname='claim_export_download'",
        )
      ).rows[0]?.n,
    ).toBe(5);
    // Only read_export_job_payload, under a live job lease, may build an export.
    for (const role of ['duefold_runtime', 'duefold_authenticator', 'duefold_worker'])
      expect(
        (
          await migrationPool.query<{ v: boolean }>(
            "SELECT has_function_privilege($1,'read_export_payload(text,text)','EXECUTE') v",
            [role],
          )
        ).rows[0]?.v,
        role,
      ).toBe(false);
  });
});

describe('export that expires while generating', () => {
  // The state expire_exports leaves an expired export in, set while the upload runs.
  const expireDuring = (key: string) =>
    migrationPool.query(
      "UPDATE export_request SET state='deletion_pending',consumed_at=statement_timestamp() WHERE object_key=$1",
      [key],
    );
  it.each([
    [
      'after the upload',
      async (input: Parameters<ExportStorage['putStream']>[0]) => {
        const size = await storage.putStream(input);
        await expireDuring(input.key);
        return size;
      },
    ],
    [
      'when the archive outgrows the ZIP limit',
      async (input: Parameters<ExportStorage['putStream']>[0]) => {
        await expireDuring(input.key);
        throw new Error('EXPORT_ZIP_LIMIT_EXCEEDED');
      },
    ],
  ])('ends the job without a retry and leaves no object %s', async (_case, putStream) => {
    const fresh = new Date();
    const generated = await generateExport({
      pool: runtimePool,
      storage: { ...storage, putStream },
      identity: identity(managerId, fresh),
      roomId,
      preset: 'room-index-audit',
      selectedDocumentIds: [],
      includeOriginals: false,
      now: fresh,
    });
    const row = (
      await migrationPool.query<{ object_key: string; state: string }>(
        'SELECT object_key,state FROM export_request WHERE id=$1',
        [generated.exportId],
      )
    ).rows[0];
    expect(row?.state).toBe('deletion_pending');
    expect(objectMap.has(row?.object_key ?? '')).toBe(false);
  });

  it('ends a retry that starts after the export expired, and still refuses a lost lease', async () => {
    const fresh = new Date();
    const requested = await requestExport({
      pool: runtimePool,
      identity: identity(managerId, fresh),
      roomId,
      preset: 'room-index-audit',
      selectedDocumentIds: [],
      includeOriginals: false,
      now: fresh,
    });
    const leaseOwner = createOpaqueId(),
      leaseToken = createOpaqueId();
    const job = (
      await migrationPool.query<{ id: string; object_key: string }>(
        `UPDATE job_queue j SET state='running',attempts=2,lease_owner=$2,lease_token=$3,
          lease_expires_at=statement_timestamp()+interval '2 minutes'
         FROM export_request e WHERE j.job_type='export.generate' AND j.payload->>'exportId'=$1
           AND e.id=$1 RETURNING j.id,e.object_key`,
        [requested.exportId, leaseOwner, leaseToken],
      )
    ).rows[0];
    if (job === undefined) throw new Error('EXPORT_JOB_FIXTURE_ABSENT');
    await expireDuring(job.object_key);
    const unused = () => Promise.reject(new Error('UNUSED'));
    const attempt = {
      pool: workerPool,
      exportId: requested.exportId,
      jobId: job.id,
      leaseOwner,
    };
    const retry = { ...storage, putStream: unused, delete: unused };
    await expect(
      generateExportJob({ ...attempt, storage: retry, leaseToken }),
    ).resolves.toBeUndefined();
    await expect(
      generateExportJob({ ...attempt, storage: retry, leaseToken: createOpaqueId() }),
    ).rejects.toMatchObject({ code: '55000' });
  });
});

describe('ZIP archive size limit', () => {
  async function publishedOriginals(count: number): Promise<string[]> {
    const jobId = createOpaqueId(),
      token = createOpaqueId();
    await migrationPool.query(
      `INSERT INTO job_queue(id,job_type,idempotency_key,payload,state,attempts,lease_owner,lease_token,lease_expires_at)
       VALUES($1,'document.source.validate',$2,'{}','running',1,$3,$4,transaction_timestamp()+interval '1 hour')`,
      [jobId, createOpaqueId(), createOpaqueId(), token],
    );
    const documents = Array.from({ length: count }, () => createOpaqueId());
    for (const id of documents) {
      const versionId = createOpaqueId();
      await migrationPool.query(
        "INSERT INTO document(id,room_id,display_title,created_by) VALUES($1,$2,'Large original',$3)",
        [id, roomId, ownerId],
      );
      await migrationPool.query(
        `INSERT INTO document_version(id,document_id,original_filename,object_key,declared_media_type,
           detected_media_type,size_bytes,sha256,state,scan_signature_version)
         VALUES($1,$2,'large.pdf',$3,'application/pdf','application/pdf',262144000,$4,'ready_for_review','1')`,
        [versionId, id, `quarantine/${createOpaqueId()}/${createOpaqueId()}`, 'a'.repeat(64)],
      );
      await migrationPool.query(
        `INSERT INTO document_scan_evidence(version_id,job_id,lease_token,signature_version,signatures_published_at)
         VALUES($1,$2,$3,'1',transaction_timestamp())`,
        [versionId, jobId, token],
      );
      await migrationPool.query(
        `INSERT INTO document_derivative(id,version_id,page_number,object_key,media_type,size_bytes,sha256,width,height,accessible_label)
         VALUES($1,$2,1,$3,'image/png',10,$4,1,1,'Page 1')`,
        [
          createOpaqueId(),
          versionId,
          `derivatives/${createOpaqueId()}/${createOpaqueId()}`,
          'b'.repeat(64),
        ],
      );
      await migrationPool.query('UPDATE document SET working_version_id=$2 WHERE id=$1', [
        id,
        versionId,
      ]);
    }
    return documents;
  }

  it('refuses an originals export estimated past the 32-bit ZIP limit before queueing it', async () => {
    // 17 maximum-size originals (250 MB each) exceed 4 GiB.
    const selected = await publishedOriginals(17);
    const fresh = new Date();
    const request = {
      pool: runtimePool,
      identity: identity(managerId, fresh),
      roomId,
      preset: 'selected-documents' as const,
      selectedDocumentIds: selected,
      now: fresh,
    };
    await expect(preflightExport({ ...request, includeOriginals: true })).rejects.toMatchObject(
      { code: '54000', message: 'EXPORT_TOO_LARGE' },
    );
    const exportsBefore = (
      await migrationPool.query<{ n: number }>('SELECT count(*)::int n FROM export_request')
    ).rows[0]?.n;
    await expect(requestExport({ ...request, includeOriginals: true })).rejects.toMatchObject({
      code: '54000',
      message: 'EXPORT_TOO_LARGE',
    });
    expect(
      (await migrationPool.query<{ n: number }>('SELECT count(*)::int n FROM export_request'))
        .rows[0]?.n,
    ).toBe(exportsBefore);
    expect(await preflightExport({ ...request, includeOriginals: false })).toMatchObject({
      fileCount: 17,
    });
  });

  it('ends an archive that outgrows the ZIP limit during generation without a retry', async () => {
    // The source grew after the request: one chunk reports a 4 GiB length.
    const [replaced] = await publishedOriginals(1);
    if (replaced === undefined) throw new Error('EXPORT_FIXTURE_ABSENT');
    const oversized = Object.defineProperty(new Uint8Array(1), 'byteLength', {
      value: 0xffffffff,
    });
    const fresh = new Date();
    const generation = generateExport({
      pool: runtimePool,
      storage: {
        ...storage,
        async putStream(input) {
          let size = 0;
          for await (const part of multipartParts(input.stream, MAX_MULTIPART_PART_BYTES))
            size += part.byteLength;
          return size;
        },
        streamSource: () =>
          Promise.resolve({
            async *[Symbol.asyncIterator]() {
              await Promise.resolve();
              yield oversized;
            },
          }),
      },
      identity: identity(managerId, fresh),
      roomId,
      preset: 'selected-documents',
      selectedDocumentIds: [replaced],
      includeOriginals: true,
      now: fresh,
    });
    // Resolving lets the job succeed instead of being retried.
    await expect(generation).resolves.toHaveProperty('exportId');
    const generated = await generation;
    expect(
      (
        await migrationPool.query<{ state: string }>(
          'SELECT state FROM export_request WHERE id=$1',
          [generated.exportId],
        )
      ).rows[0]?.state,
    ).toBe('failed');
    for (const role of ['duefold_runtime', 'duefold_authenticator', 'duefold_worker'])
      expect(
        (
          await migrationPool.query<{ v: boolean }>(
            "SELECT has_function_privilege($1,'fail_export_job(text,text,text,text)','EXECUTE') v",
            [role],
          )
        ).rows[0]?.v,
        role,
      ).toBe(role === 'duefold_worker');
  });
});

describe('room index and audit export paging', () => {
  it('streams an audit trail longer than one page in order, in the document the single payload produced', async () => {
    await migrationPool.query(
      `INSERT INTO audit_event(id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,result,reason_code,correlation_id)
       SELECT substr(md5(random()::text||g),1,32),'room.metadata','member',$1,$2,'document',$3,'success','FIXTURE','corr_'||md5(g||random()::text)
       FROM generate_series(1,1200) g`,
      [ownerId, roomId, documentId],
    );
    const chunks: Uint8Array[] = [];
    const fresh = new Date();
    const generated = await generateExport({
      pool: runtimePool,
      storage: {
        ...storage,
        putStream(input) {
          return storage.putStream({
            ...input,
            stream: (async function* () {
              for await (const chunk of input.stream) {
                chunks.push(chunk);
                yield chunk;
              }
            })(),
          });
        },
      },
      identity: identity(managerId, fresh),
      roomId,
      preset: 'room-index-audit',
      selectedDocumentIds: [],
      includeOriginals: false,
      now: fresh,
    });
    // The pre-paging payload, built in one statement, is the oracle for the bytes.
    const expected = (
      await migrationPool.query<{ object_key: string; audit_rows: number; document: unknown }>(
        `SELECT e.object_key,(SELECT count(*)::int FROM audit_event a WHERE a.room_id=e.room_id) audit_rows,
           jsonb_build_object('preset',e.preset,'roomId',e.room_id,
             'index',COALESCE((SELECT jsonb_agg(jsonb_build_object('kind',p.resource_kind,'id',p.resource_id,'name',p.display_name) ORDER BY p.order_key,p.entry_id) FROM published_structure_entry p WHERE p.room_id=e.room_id),'[]'::jsonb),
             'audit',COALESCE((SELECT jsonb_agg(jsonb_build_object('sequence',a.sequence,'eventType',a.event_type,'result',a.result,'occurredAt',a.occurred_at) ORDER BY a.sequence) FROM audit_event a WHERE a.room_id=e.room_id),'[]'::jsonb)) document
         FROM export_request e WHERE e.id=$1`,
        [generated.exportId],
      )
    ).rows[0];
    if (expected === undefined) throw new Error('EXPORT_FIXTURE_ABSENT');
    expect(expected.audit_rows).toBeGreaterThan(1_000);
    const written = Buffer.from(objectMap.get(expected.object_key) ?? []).toString('utf8');
    expect(written).toBe(`${JSON.stringify(expected.document)}\n`);
    expect(written).not.toContain(expected.object_key);
    // Opening bracket, one chunk per 1,000-row page, and the closing remainder.
    expect(chunks).toHaveLength(Math.ceil(expected.audit_rows / 1_000) + 2);
    await expect(
      workerPool.query('SELECT * FROM read_export_audit_page($1,$2,$3,$4,0)', [
        generated.exportId,
        createOpaqueId(),
        createOpaqueId(),
        createOpaqueId(),
      ]),
    ).rejects.toMatchObject({ code: '55000' });
    for (const role of ['duefold_runtime', 'duefold_authenticator', 'duefold_worker'])
      expect(
        (
          await migrationPool.query<{ v: boolean }>(
            "SELECT has_function_privilege($1,'read_export_audit_page(text,text,text,text,bigint)','EXECUTE') v",
            [role],
          )
        ).rows[0]?.v,
        role,
      ).toBe(role === 'duefold_worker');
  });

  // mark_export_job_ready does not re-check manager rights, so this refusal is what
  // keeps a demoted creator's export from completing with a cut-short audit trail.
  it('refuses the next audit page once the creator is no longer a manager', async () => {
    const fresh = new Date();
    const requested = await requestExport({
      pool: runtimePool,
      identity: identity(secondManagerId, fresh),
      roomId,
      preset: 'room-index-audit',
      selectedDocumentIds: [],
      includeOriginals: false,
      now: fresh,
    });
    const lease = await leaseExportJob(requested.exportId);
    const page = () =>
      workerPool.query('SELECT * FROM read_export_audit_page($1,$2,$3,$4,0)', [
        requested.exportId,
        lease.jobId,
        lease.leaseOwner,
        lease.leaseToken,
      ]);
    await expect(page()).resolves.toHaveProperty('rows');
    await migrationPool.query(
      "UPDATE room_assignment SET room_role='contributor' WHERE room_id=$1 AND member_id=$2",
      [roomId, secondManagerId],
    );
    await expect(page()).rejects.toMatchObject({
      code: '55000',
      message: 'export unavailable',
    });
  });
});
