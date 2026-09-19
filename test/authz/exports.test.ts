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
async function generateExport(
  input: Parameters<typeof requestExport>[0] & { readonly storage: ExportStorage },
): Promise<Awaited<ReturnType<typeof requestExport>>> {
  const requested = await requestExport(input);
  const leaseOwner = createOpaqueId();
  const leaseToken = createOpaqueId();
  const job = (
    await migrationPool.query<{ id: string }>(
      `UPDATE job_queue SET state='running',attempts=attempts+1,lease_owner=$2,lease_token=$3,
        lease_expires_at=statement_timestamp()+interval '2 minutes'
       WHERE job_type='export.generate' AND payload->>'exportId'=$1 RETURNING id`,
      [requested.exportId, leaseOwner, leaseToken],
    )
  ).rows[0];
  if (job === undefined) throw new Error('EXPORT_JOB_FIXTURE_ABSENT');
  await generateExportJob({
    pool: workerPool,
    storage: input.storage,
    exportId: requested.exportId,
    jobId: job.id,
    leaseOwner,
    leaseToken,
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
    expect(
      await downloadExportOnce({
        pool: runtimePool,
        storage,
        identity: identity(managerId, now),
        exportId: allowed.exportId,
      }),
    ).toMatchObject({ contentType: 'application/json' });
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
    await runtimePool.query('SELECT mark_export_ready($1,$2,$3)', [id, managerId, 1]);
    await migrationPool.query(
      "UPDATE export_request SET expires_at=statement_timestamp()+interval '2 seconds' WHERE id=$1",
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
  });
});
