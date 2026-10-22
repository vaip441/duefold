import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import { createHandler as createTrashPurgeHandler } from '../../modules/rooms-documents/src/jobs/trash-purge.ts';
import { generatedMigrations } from '../../.duefold/generated/migrations.ts';
import { migrate } from '../../modules/core-security/src/db/migrate.ts';

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
const ownerId = createOpaqueId(),
  contributorId = createOpaqueId();
const roomId = createOpaqueId();
function audit(): readonly [string, string] {
  return [createOpaqueId(), createCorrelationId()];
}
async function workingRevision(): Promise<number> {
  const row = (
    await migrationPool.query<{ working_revision: number }>(
      'SELECT working_revision FROM room WHERE id=$1',
      [roomId],
    )
  ).rows[0];
  if (!row) throw new Error('ROOM_ABSENT');
  return row.working_revision;
}
async function mutate(id: string, parentFolderId: string | null, removed: boolean) {
  const e = (
    await migrationPool.query<{ revision: number; order_key: string; display_name: string }>(
      'SELECT revision,order_key::text,display_name FROM working_structure_entry WHERE id=$1',
      [id],
    )
  ).rows[0];
  if (!e) throw new Error('ENTRY_ABSENT');
  await runtimePool.query(
    'SELECT * FROM mutate_structure_entry($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [
      id,
      parentFolderId,
      e.display_name,
      e.order_key,
      removed,
      contributorId,
      e.revision,
      await workingRevision(),
      ...audit(),
    ],
  );
}
/** Ages the entry's trash past retention and runs its purge job; returns the deleted keys. */
async function purgeTrash(entryId: string): Promise<{ trashId: string; deleted: string[] }> {
  const trash = (
    await migrationPool.query<{ id: string }>(
      'SELECT id FROM room_trash WHERE root_entry_id=$1',
      [entryId],
    )
  ).rows[0];
  if (!trash) throw new Error('TRASH_ABSENT');
  await migrationPool.query('ALTER TABLE room_trash DISABLE TRIGGER fixed_trash_retention');
  try {
    await migrationPool.query(
      "UPDATE room_trash SET trashed_at=transaction_timestamp()-interval '31 days',purge_after=transaction_timestamp()-interval '1 day' WHERE id=$1",
      [trash.id],
    );
  } finally {
    await migrationPool.query('ALTER TABLE room_trash ENABLE TRIGGER fixed_trash_retention');
  }
  const owner = createOpaqueId(),
    token = createOpaqueId();
  const job = (
    await migrationPool.query<{ id: string }>(
      `UPDATE job_queue SET state='running',attempts=1,lease_owner=$2,lease_token=$3,
         lease_expires_at=transaction_timestamp()+interval '1 hour'
       WHERE job_type='room.trash.purge' AND payload->>'trashId'=$1 RETURNING id`,
      [trash.id, owner, token],
    )
  ).rows[0];
  if (!job) throw new Error('JOB_ABSENT');
  const deleted: string[] = [];
  const unused = () => Promise.reject(new Error('UNUSED'));
  const handler = createTrashPurgeHandler({
    pool: workerPool,
    storage: {
      checksumSupport: true,
      checkReady: () => Promise.resolve(),
      createMultipart: unused,
      presignPart: unused,
      completeMultipart: unused,
      abortMultipart: unused,
      headObject: unused,
      deleteObject: unused,
      deleteObjects: (keys: readonly string[]) => {
        deleted.push(...keys);
        return Promise.resolve();
      },
      getObjectBytes: unused,
      streamObject: unused,
      putExportStream: unused,
      putBrandingAsset: unused,
      putSystemDeletionMarker: unused,
      listDeletionMarkedRoomIds: unused,
      putDerivative: unused,
    },
  });
  await handler(
    {
      id: job.id,
      job_type: 'room.trash.purge',
      payload: { trashId: trash.id },
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
  return { trashId: trash.id, deleted };
}

async function createPublishedDocument(
  documentId: string,
  entryId: string,
  versionId: string,
  title: string,
  orderKey: number,
): Promise<void> {
  await runtimePool.query(
    'INSERT INTO document(id,room_id,display_title,created_by) VALUES($1,$2,$3,$4)',
    [documentId, roomId, title, contributorId],
  );
  await migrationPool.query(
    `INSERT INTO document_version(id,document_id,original_filename,object_key,declared_media_type,size_bytes,state)
     VALUES($1,$2,'published.pdf',$3,'application/pdf',10,'quarantine')`,
    [versionId, documentId, `quarantine/${createOpaqueId()}/${createOpaqueId()}`],
  );
  await runtimePool.query('SELECT create_document_entry($1,$2,NULL,$3,$4,$5,$6,$7,$8)', [
    entryId,
    documentId,
    title,
    orderKey,
    contributorId,
    await workingRevision(),
    ...audit(),
  ]);
  await migrationPool.query(
    `INSERT INTO published_structure_entry(room_id,entry_id,resource_kind,resource_id,parent_folder_id,display_name,description,order_key,source_revision,published_version_id)
     VALUES($1,$2,'document',$3,NULL,$4,'',$5,1,$6)`,
    [roomId, entryId, documentId, title, orderKey, versionId],
  );
}
async function createFolder(folderId: string, name: string, orderKey: number): Promise<void> {
  await runtimePool.query('SELECT create_folder_entry($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9)', [
    folderId,
    roomId,
    name,
    '',
    orderKey,
    contributorId,
    await workingRevision(),
    ...audit(),
  ]);
}
async function publishRoom(): Promise<void> {
  const room = (
    await migrationPool.query<{ published_revision: number }>(
      'SELECT published_revision FROM room WHERE id=$1',
      [roomId],
    )
  ).rows[0];
  if (!room) throw new Error('ROOM_ABSENT');
  await migrationPool.query('SELECT publish_room_structure($1,$2,$3,$4,$5,$6)', [
    roomId,
    ownerId,
    await workingRevision(),
    room.published_revision,
    ...audit(),
  ]);
}

const released = {
  documentId: createOpaqueId(),
  entryId: createOpaqueId(),
  versionId: createOpaqueId(),
  folderId: createOpaqueId(),
};
/** Released 1.3.0 trashed this folder at once although it holds published content. */
async function seedReleasedPublishedDocumentInRemovedFolder(): Promise<void> {
  await createPublishedDocument(
    released.documentId,
    released.entryId,
    released.versionId,
    'Released purge target',
    7500,
  );
  await createFolder(released.folderId, 'Released draft folder', 7600);
  await mutate(released.entryId, released.folderId, false);
  await mutate(released.folderId, null, true);
  const trashed = await migrationPool.query(
    "SELECT 1 FROM room_trash t JOIN job_queue j ON j.idempotency_key='trash-purge:'||t.id WHERE t.root_entry_id=$1",
    [released.folderId],
  );
  if (trashed.rowCount !== 1) throw new Error('RELEASED_TRASH_ABSENT');
}

beforeAll(async () => {
  await bootstrapPool.query(
    'DROP SCHEMA public CASCADE; CREATE SCHEMA public; ALTER SCHEMA public OWNER TO duefold_migration;',
  );
  // Starts at the last released schema so the upgrade repair of earlier trash runs.
  await migrate(
    migrationPool,
    generatedMigrations.filter(({ id }) => id < '035'),
  );
  const c = await migrationPool.connect();
  try {
    await c.query('BEGIN');
    for (const [id, email, role] of [
      [ownerId, 'purge-owner@example.com', 'owner'],
      [contributorId, 'purge-contributor@example.com', 'member'],
    ] as const)
      await c.query(
        "INSERT INTO member(id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state) VALUES($1,$2,$2,'https://issuer.example',$1,$3,'active')",
        [id, email, role],
      );
    await c.query("INSERT INTO organization(id,name) VALUES($1,'Test Organization')", [
      createOpaqueId(),
    ]);
    await c.query('SELECT create_room($1,$2,$3,$4,$5,$6)', [
      roomId,
      'Investor Room',
      'Purge fixtures',
      ownerId,
      ...audit(),
    ]);
    await c.query(
      "INSERT INTO room_assignment(id,room_id,member_id,room_role) VALUES($1,$2,$3,'contributor')",
      [createOpaqueId(), roomId, contributorId],
    );
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  await seedReleasedPublishedDocumentInRemovedFolder();
  await migrate(migrationPool, generatedMigrations);
});
afterAll(async () => {
  await runtimePool.end();
  await workerPool.end();
  await migrationPool.end();
  await bootstrapPool.end();
});

describe('upgrade from a released schema', () => {
  it('returns trash holding published content to staged removal until publication', async () => {
    const state = async () =>
      (
        await migrationPool.query<{
          trashed: number;
          purgeJobs: number;
          stagedRemoved: boolean;
        }>(
          `SELECT (SELECT count(*) FROM room_trash WHERE root_entry_id=$1)::int AS trashed,
             (SELECT count(*) FROM job_queue j WHERE j.job_type='room.trash.purge'
               AND NOT EXISTS(SELECT 1 FROM room_trash t WHERE j.payload->>'trashId'=t.id))::int AS "purgeJobs",
             (SELECT staged_removed FROM working_structure_entry WHERE id=$1) AS "stagedRemoved"`,
          [released.folderId],
        )
      ).rows[0];
    expect(await state()).toEqual({ trashed: 0, purgeJobs: 0, stagedRemoved: true });
    await publishRoom();
    expect(await state()).toEqual({ trashed: 1, purgeJobs: 0, stagedRemoved: true });
    await purgeTrash(released.folderId);
    expect(
      (
        await migrationPool.query<{ remaining: number }>(
          `SELECT ((SELECT count(*) FROM document_version WHERE id=$1)
             + (SELECT count(*) FROM room_trash WHERE root_entry_id=$2))::int AS remaining`,
          [released.versionId, released.folderId],
        )
      ).rows[0]?.remaining,
    ).toBe(0);
  });
});

describe('trash purge of delivered content', () => {
  it('purges a document an investor previewed, downloaded, and has watermark pages for', async () => {
    const documentId = createOpaqueId(),
      entryId = createOpaqueId(),
      versionId = createOpaqueId(),
      derivativeId = createOpaqueId(),
      viewerId = createOpaqueId(),
      sessionId = createOpaqueId(),
      activityId = createOpaqueId();
    const watermarkKey = `watermarks/${createOpaqueId()}/${createOpaqueId()}`;
    await runtimePool.query(
      "INSERT INTO document(id,room_id,display_title,created_by) VALUES($1,$2,'Viewed purge target',$3)",
      [documentId, roomId, contributorId],
    );
    await migrationPool.query(
      `INSERT INTO document_version(id,document_id,original_filename,object_key,declared_media_type,size_bytes,state)
       VALUES($1,$2,'viewed.pdf',$3,'application/pdf',10,'quarantine')`,
      [versionId, documentId, `quarantine/${createOpaqueId()}/${createOpaqueId()}`],
    );
    await migrationPool.query(
      `INSERT INTO document_derivative(id,version_id,page_number,object_key,media_type,size_bytes,sha256,width,height,accessible_label)
       VALUES($1,$2,1,$3,'image/png',10,$4,1,1,'Page 1')`,
      [
        derivativeId,
        versionId,
        `derivatives/${createOpaqueId()}/${createOpaqueId()}`,
        'c'.repeat(64),
      ],
    );
    await migrationPool.query(
      "INSERT INTO viewer(id,email_key,email_display,state,session_family_id) VALUES($1,'purge-viewer@example.com','purge-viewer@example.com','active',$2)",
      [viewerId, createOpaqueId()],
    );
    await migrationPool.query(
      `INSERT INTO session(id,secret_digest,csrf_digest,principal_kind,viewer_id,family_id,idle_expires_at,absolute_expires_at)
       VALUES($1,$2,$3,'viewer',$4,$5,statement_timestamp()+interval '1 hour',statement_timestamp()+interval '2 hours')`,
      [
        sessionId,
        createOpaqueId().padEnd(64, 'd'),
        createOpaqueId().padEnd(64, 'c'),
        viewerId,
        createOpaqueId(),
      ],
    );
    await migrationPool.query(
      `INSERT INTO preview_activity(id,viewer_id,session_id,room_id,document_id,version_id,correlation_id,
         network_period,network_hmac,browser_category,os_category,device_category)
       VALUES($1,$2,$3,$4,$5,$6,$7,'2026-10',$8,'chromium','linux','desktop')`,
      [
        activityId,
        viewerId,
        sessionId,
        roomId,
        documentId,
        versionId,
        createCorrelationId(),
        'a'.repeat(64),
      ],
    );
    await migrationPool.query(
      'INSERT INTO preview_delivery_telemetry(activity_id,page_number) VALUES($1,1)',
      [activityId],
    );
    await migrationPool.query(
      `INSERT INTO watermark_cache(id,viewer_id,session_id,room_id,document_id,version_id,derivative_id,
         page_number,object_key,media_type,state,access_date,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,'image/png','active',current_date,statement_timestamp()+interval '1 hour')`,
      [
        createOpaqueId(),
        viewerId,
        sessionId,
        roomId,
        documentId,
        versionId,
        derivativeId,
        watermarkKey,
      ],
    );
    await migrationPool.query(
      `INSERT INTO download_lease(id,viewer_id,session_id,room_id,document_id,version_id,correlation_id,
         size_bytes,state,expires_at,summarized_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,10,'completed',statement_timestamp()+interval '10 minutes',statement_timestamp())`,
      [
        createOpaqueId(),
        viewerId,
        sessionId,
        roomId,
        documentId,
        versionId,
        createCorrelationId(),
      ],
    );
    await runtimePool.query('SELECT create_document_entry($1,$2,NULL,$3,8500,$4,$5,$6,$7)', [
      entryId,
      documentId,
      'Viewed purge target',
      contributorId,
      await workingRevision(),
      ...audit(),
    ]);
    await mutate(entryId, null, true);
    // The watermarked page image is still live when purge runs.
    expect(
      (
        await migrationPool.query<{ state: string }>(
          'SELECT state FROM watermark_cache WHERE object_key=$1',
          [watermarkKey],
        )
      ).rows[0]?.state,
    ).toMatch(/^(active|deletion_pending)$/u);
    const { trashId, deleted } = await purgeTrash(entryId);
    expect(deleted).toContain(watermarkKey);
    expect(
      (
        await migrationPool.query<{ remaining: number }>(
          `SELECT ((SELECT count(*) FROM preview_activity WHERE version_id=$1)
             + (SELECT count(*) FROM preview_delivery_telemetry WHERE activity_id=$2)
             + (SELECT count(*) FROM watermark_cache WHERE version_id=$1)
             + (SELECT count(*) FROM download_lease WHERE version_id=$1)
             + (SELECT count(*) FROM document_version WHERE id=$1)
             + (SELECT count(*) FROM room_trash WHERE id=$3))::int AS remaining`,
          [versionId, activityId, trashId],
        )
      ).rows[0]?.remaining,
    ).toBe(0);
  });

  it('keeps a published document moved into a removed draft folder visible until publication', async () => {
    const documentId = createOpaqueId(),
      entryId = createOpaqueId(),
      versionId = createOpaqueId(),
      folderId = createOpaqueId();
    await createPublishedDocument(
      documentId,
      entryId,
      versionId,
      'Published purge target',
      9500,
    );
    await createFolder(folderId, 'Draft folder', 9600);
    await mutate(entryId, folderId, false);
    await mutate(folderId, null, true);
    const state = async () =>
      (
        await migrationPool.query<{ trashed: number; published: number }>(
          `SELECT (SELECT count(*) FROM room_trash WHERE root_entry_id=$1)::int AS trashed,
             (SELECT count(*) FROM published_structure_entry WHERE room_id=$2 AND resource_id=$3)::int AS published`,
          [folderId, roomId, documentId],
        )
      ).rows[0];
    expect(await state()).toEqual({ trashed: 0, published: 1 });
    await publishRoom();
    expect(await state()).toEqual({ trashed: 1, published: 0 });
    await purgeTrash(folderId);
    expect(
      (
        await migrationPool.query<{ remaining: number }>(
          'SELECT count(*)::int AS remaining FROM document_version WHERE id=$1',
          [versionId],
        )
      ).rows[0]?.remaining,
    ).toBe(0);
  });
});
