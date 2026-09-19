import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import { generatedMigrations } from '../../.duefold/generated/migrations.ts';
import { migrate } from '../../modules/core-security/src/db/migrate.ts';

async function readPublishedStructure(pool: Pool, targetRoomId: string) {
  const result = await pool.query<{
    entry_id: string;
    resource_kind: 'folder' | 'document';
    resource_id: string;
    parent_folder_id: string | null;
    display_name: string;
    description: string;
    order_key: string;
    published_version_id: string | null;
  }>(
    `SELECT p.entry_id,p.resource_kind,p.resource_id,p.parent_folder_id,p.display_name,
      p.description,p.order_key::text,p.published_version_id
     FROM published_structure_entry p JOIN room r ON r.id=p.room_id
     WHERE p.room_id=$1 AND r.state='published' ORDER BY p.order_key,p.entry_id`,
    [targetRoomId],
  );
  return result.rows.map((row) => ({
    entryId: row.entry_id,
    resourceKind: row.resource_kind,
    resourceId: row.resource_id,
    parentFolderId: row.parent_folder_id,
    displayName: row.display_name,
    description: row.description,
    orderKey: row.order_key,
    publishedVersionId: row.published_version_id,
  }));
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
const ownerId = createOpaqueId(),
  managerId = createOpaqueId(),
  contributorId = createOpaqueId(),
  roomId = createOpaqueId();
const publishedFolderId = createOpaqueId(),
  removedFolderId = createOpaqueId(),
  documentId = createOpaqueId();
const publishedVersionId = createOpaqueId(),
  workingVersionId = createOpaqueId();
function audit(): readonly [string, string] {
  return [createOpaqueId(), createCorrelationId()];
}
async function revisions(): Promise<{
  revision: number;
  working_revision: number;
  published_revision: number;
  state: string;
}> {
  const r = (
    await migrationPool.query<{
      revision: number;
      working_revision: number;
      published_revision: number;
      state: string;
    }>('SELECT revision,working_revision,published_revision,state FROM room WHERE id=$1', [
      roomId,
    ])
  ).rows[0];
  if (!r) throw new Error('room absent');
  return r;
}
async function addFolder(id: string, name: string, order: number) {
  const r = await revisions();
  await runtimePool.query('SELECT create_folder_entry($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9)', [
    id,
    roomId,
    name,
    `${name} description`,
    order,
    contributorId,
    r.working_revision,
    ...audit(),
  ]);
}
async function mutate(id: string, name: string, removed: boolean) {
  const entry = (
    await migrationPool.query<{ revision: number; order_key: string }>(
      'SELECT revision,order_key::text FROM working_structure_entry WHERE id=$1',
      [id],
    )
  ).rows[0];
  if (entry === undefined) throw new Error('working entry absent');
  const r = await revisions();
  await runtimePool.query(
    'SELECT * FROM mutate_structure_entry($1,NULL,$2,$3,$4,$5,$6,$7,$8,$9)',
    [
      id,
      name,
      entry.order_key,
      removed,
      contributorId,
      entry.revision,
      r.working_revision,
      ...audit(),
    ],
  );
}
async function acceptVersion(versionId: string): Promise<void> {
  const intentId = createOpaqueId();
  const sourceKey = `quarantine/${createOpaqueId()}/${createOpaqueId()}`;
  await runtimePool.query(
    `INSERT INTO upload_intent
      (id,room_id,member_id,document_id,display_title,original_filename,declared_media_type,
       declared_size,object_key,upload_id,part_plan,state,expires_at)
     VALUES($1,$2,$3,$4,'Published model','model.pdf','application/pdf',10,$5,$6,$7::jsonb,
       'open',transaction_timestamp()+interval '1 hour')`,
    [
      intentId,
      roomId,
      contributorId,
      documentId,
      sourceKey,
      createOpaqueId(),
      '[{"partNumber":1,"size":10}]',
    ],
  );
  await runtimePool.query("UPDATE upload_intent SET state='completing' WHERE id=$1", [
    intentId,
  ]);
  await runtimePool.query('SELECT create_quarantined_document_version($1,$2,$3,$4,10,$5,$6)', [
    versionId,
    documentId,
    intentId,
    contributorId,
    ...audit(),
  ]);
  const jobId = createOpaqueId();
  const leaseOwner = createOpaqueId();
  const leaseToken = createOpaqueId();
  await workerPool.query(
    `INSERT INTO job_queue(id,job_type,idempotency_key,payload,state,attempts,lease_owner,lease_token,lease_expires_at)
     VALUES($1,'document.source.validate',$2,jsonb_build_object('versionId',$3::text),'running',1,$4,$5,
       transaction_timestamp()+interval '1 hour')`,
    [jobId, createOpaqueId(), versionId, leaseOwner, leaseToken],
  );
  const signaturesAt = new Date();
  await workerPool.query('SELECT record_scanner_observation($1,$2,$3,$4,$5,$6)', [
    versionId,
    jobId,
    leaseOwner,
    leaseToken,
    '1',
    signaturesAt,
  ]);
  await workerPool.query('SELECT record_clean_scan($1,$2,$3,$4,$5,$6,$7,$8)', [
    versionId,
    jobId,
    leaseOwner,
    leaseToken,
    '1',
    signaturesAt,
    ...audit(),
  ]);
  const derivativeKey = `derivatives/${createOpaqueId()}/${createOpaqueId()}`;
  const derivativeSha = 'b'.repeat(64);
  await workerPool.query('SELECT record_verified_derivative($1,$2,$3,$4,$5,10,$6)', [
    versionId,
    jobId,
    leaseOwner,
    leaseToken,
    derivativeKey,
    derivativeSha,
  ]);
  const derivative = [
    {
      id: createOpaqueId(),
      page_number: 1,
      object_key: derivativeKey,
      media_type: 'image/png',
      size_bytes: 10,
      sha256: derivativeSha,
      width: 1,
      height: 1,
      accessible_label: 'Page 1',
      text_layer: null,
    },
  ];
  await workerPool.query(
    'SELECT accept_processed_version($1,$2,$3,$4,$5,$6,false,$7::jsonb,$8,$9,0)',
    [
      versionId,
      jobId,
      leaseOwner,
      leaseToken,
      'application/pdf',
      'a'.repeat(64),
      JSON.stringify(derivative),
      ...audit(),
    ],
  );
}

async function publish() {
  const r = await revisions();
  const impact = (
    await runtimePool.query<{ dry_run_bulk_publish: { confirmation: string } }>(
      'SELECT dry_run_bulk_publish($1,$2)',
      [managerId, roomId],
    )
  ).rows[0]?.dry_run_bulk_publish;
  if (impact === undefined) throw new Error('publish impact absent');
  await runtimePool.query('SELECT apply_bulk_publish($1,$2,$3,$4,$5,$6,$7,$8)', [
    managerId,
    roomId,
    r.working_revision,
    r.published_revision,
    new Date(),
    impact.confirmation,
    ...audit(),
  ]);
}
async function state(value: 'draft' | 'published' | 'archived') {
  const r = await revisions();
  await runtimePool.query('SELECT change_room_state($1,$2,$3,$4,$5,$6)', [
    roomId,
    value,
    managerId,
    r.revision,
    ...audit(),
  ]);
}

beforeAll(async () => {
  await bootstrapPool.query(
    'DROP SCHEMA public CASCADE; CREATE SCHEMA public; ALTER SCHEMA public OWNER TO duefold_migration;',
  );
  await migrate(migrationPool, generatedMigrations);
  const c = await migrationPool.connect();
  try {
    await c.query('BEGIN');
    for (const [id, email, role] of [
      [ownerId, 'projection-owner@example.com', 'owner'],
      [managerId, 'projection-manager@example.com', 'member'],
      [contributorId, 'projection-contributor@example.com', 'member'],
    ] as const)
      await c.query(
        "INSERT INTO member(id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state) VALUES($1,$2,$2,'https://issuer.example',$1,$3,'active')",
        [id, email, role],
      );
    await c.query("INSERT INTO organization(id,name) VALUES($1,'Projection authz')", [
      createOpaqueId(),
    ]);
    await c.query('SELECT create_room($1,$2,$3,$4,$5,$6)', [
      roomId,
      'Projection 📈 Revenue-2026 Äriplaan 投資家向け資料',
      '',
      ownerId,
      ...audit(),
    ]);
    await c.query(
      "INSERT INTO room_assignment(id,room_id,member_id,room_role) VALUES($1,$2,$3,'manager'),($4,$2,$5,'contributor')",
      [createOpaqueId(), roomId, managerId, createOpaqueId(), contributorId],
    );
    await c.query(
      "INSERT INTO document(id,room_id,display_title,created_by) VALUES($1,$2,'Published model',$3)",
      [documentId, roomId, contributorId],
    );
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  await acceptVersion(publishedVersionId);
  await acceptVersion(workingVersionId);
  await addFolder(publishedFolderId, 'Published folder', 1024);
  await addFolder(removedFolderId, 'Published then removed', 2048);
  let r = await revisions();
  await runtimePool.query('SELECT create_document_entry($1,$2,NULL,$3,$4,$5,$6,$7,$8)', [
    createOpaqueId(),
    documentId,
    'Published model',
    3072,
    contributorId,
    r.working_revision,
    ...audit(),
  ]);
  r = await revisions();
  const d = (
    await migrationPool.query<{ revision: number }>(
      'SELECT revision FROM document WHERE id=$1',
      [documentId],
    )
  ).rows[0];
  if (d === undefined) throw new Error('document absent');
  await runtimePool.query(
    'SELECT * FROM update_document_metadata($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [
      documentId,
      'Published model',
      'Published description',
      publishedVersionId,
      contributorId,
      d.revision,
      r.working_revision,
      ...audit(),
    ],
  );
  await publish();
  await state('published');
});
afterAll(async () => {
  await runtimePool.end();
  await workerPool.end();
  await migrationPool.end();
  await bootstrapPool.end();
});

describe('published structure projection authorization boundary', () => {
  it('dry-run names every viewer-visible publication field using the shared snapshot definition', async () => {
    async function inRolledBackChange(
      change: (client: PoolClient) => Promise<void>,
      expectedKind: 'description' | 'version' | 'move' | 'reorder',
      expectedPath: string,
    ): Promise<void> {
      const client = await runtimePool.connect();
      try {
        await client.query('BEGIN');
        await change(client);
        const impact = (
          await client.query<{
            dry_run_bulk_publish: {
              affectedCount: number;
              paths: readonly string[];
              items: readonly { path: string; changes: readonly string[] }[];
            };
          }>('SELECT dry_run_bulk_publish($1,$2)', [managerId, roomId])
        ).rows[0]?.dry_run_bulk_publish;
        expect(impact?.affectedCount).toBeGreaterThan(0);
        expect(impact?.paths).toContain(expectedPath);
        expect(impact?.items.find((item) => item.path === expectedPath)?.changes).toContain(
          expectedKind,
        );
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    }

    const folderEntry = (
      await migrationPool.query<{ revision: number; order_key: string; display_name: string }>(
        'SELECT revision,order_key::text,display_name FROM working_structure_entry WHERE id=$1',
        [publishedFolderId],
      )
    ).rows[0];
    const base = await revisions();
    if (folderEntry === undefined) throw new Error('FOLDER_ENTRY_ABSENT');
    await inRolledBackChange(
      async (client) => {
        await client.query('SELECT * FROM update_folder_description($1,$2,$3,$4,$5,$6,$7)', [
          publishedFolderId,
          'Description-only staged value',
          contributorId,
          folderEntry.revision,
          base.working_revision,
          ...audit(),
        ]);
      },
      'description',
      'Published folder',
    );
    await inRolledBackChange(
      async (client) => {
        await client.query(
          'SELECT * FROM mutate_structure_entry($1,NULL,$2,$3,false,$4,$5,$6,$7,$8)',
          [
            publishedFolderId,
            folderEntry.display_name,
            Number(folderEntry.order_key) + 11,
            contributorId,
            folderEntry.revision,
            base.working_revision,
            ...audit(),
          ],
        );
      },
      'reorder',
      'Published folder',
    );
    await inRolledBackChange(
      async (client) => {
        await client.query(
          'SELECT * FROM mutate_structure_entry($1,$2,$3,$4,false,$5,$6,$7,$8,$9)',
          [
            publishedFolderId,
            removedFolderId,
            folderEntry.display_name,
            folderEntry.order_key,
            contributorId,
            folderEntry.revision,
            base.working_revision,
            ...audit(),
          ],
        );
      },
      'move',
      'Published then removed / Published folder',
    );
    const document = (
      await migrationPool.query<{
        revision: number;
        display_title: string;
        description: string;
      }>('SELECT revision,display_title,description FROM document WHERE id=$1', [documentId])
    ).rows[0];
    if (document === undefined) throw new Error('DOCUMENT_ABSENT');
    await inRolledBackChange(
      async (client) => {
        await client.query(
          'SELECT * FROM update_document_metadata($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            documentId,
            document.display_title,
            document.description,
            workingVersionId,
            contributorId,
            document.revision,
            base.working_revision,
            ...audit(),
          ],
        );
      },
      'version',
      'Published model',
    );
  });

  it('returns populated published values while excluding divergent working changes in the same call', async () => {
    await mutate(publishedFolderId, 'Working-only rename', false);
    await mutate(removedFolderId, 'Published then removed', true);
    await addFolder(createOpaqueId(), 'Draft-only folder', 4096);
    const r = await revisions();
    const d = (
      await migrationPool.query<{ revision: number }>(
        'SELECT revision FROM document WHERE id=$1',
        [documentId],
      )
    ).rows[0];
    if (d === undefined) throw new Error('document absent');
    await runtimePool.query(
      'SELECT * FROM update_document_metadata($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        documentId,
        'Working-only title',
        'Working-only description',
        workingVersionId,
        contributorId,
        d.revision,
        r.working_revision,
        ...audit(),
      ],
    );
    const visible = await readPublishedStructure(migrationPool, roomId);
    expect(visible.map((item) => item.displayName)).toEqual([
      'Published folder',
      'Published then removed',
      'Published model',
    ]);
    expect(visible.find((item) => item.resourceId === documentId)).toMatchObject({
      description: 'Published description',
      publishedVersionId,
    });
    expect(JSON.stringify(visible)).not.toMatch(/Working-only|Draft-only/);
    expect(JSON.stringify(visible)).not.toContain(workingVersionId);
  });

  it('uses room draft and archive as an immediate global projection kill switch after a populated positive arm', async () => {
    expect((await readPublishedStructure(migrationPool, roomId)).length).toBeGreaterThan(0);
    await state('draft');
    expect(await readPublishedStructure(migrationPool, roomId)).toEqual([]);
    const before = await revisions();
    await runtimePool.query('SELECT change_room_state($1,$2,$3,$4,$5,$6)', [
      roomId,
      'published',
      managerId,
      before.revision,
      ...audit(),
    ]);
    expect((await readPublishedStructure(migrationPool, roomId)).length).toBeGreaterThan(0);
    await state('archived');
    expect(await readPublishedStructure(migrationPool, roomId)).toEqual([]);
  });

  it('rolls publication and audit back atomically when snapshot replacement fails', async () => {
    await state('draft');
    const priorSnapshot = (
      await migrationPool.query(
        'SELECT entry_id,display_name FROM published_structure_entry WHERE room_id=$1 ORDER BY entry_id',
        [roomId],
      )
    ).rows;
    const priorRevision = (await revisions()).published_revision;
    await migrationPool.query(
      `CREATE FUNCTION fail_snapshot_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.display_name='Working-only rename' THEN RAISE EXCEPTION 'injected snapshot failure'; END IF; RETURN NEW; END $$`,
    );
    await migrationPool.query(
      'CREATE TRIGGER fail_snapshot_insert BEFORE INSERT ON published_structure_entry FOR EACH ROW EXECUTE FUNCTION fail_snapshot_insert()',
    );
    try {
      const current = await revisions();
      const impact = (
        await runtimePool.query<{ dry_run_bulk_publish: { confirmation: string } }>(
          'SELECT dry_run_bulk_publish($1,$2)',
          [managerId, roomId],
        )
      ).rows[0]?.dry_run_bulk_publish;
      await expect(
        runtimePool.query('SELECT apply_bulk_publish($1,$2,$3,$4,$5,$6,$7,$8)', [
          managerId,
          roomId,
          current.working_revision,
          current.published_revision,
          new Date(),
          impact?.confirmation,
          ...audit(),
        ]),
      ).rejects.toThrow('injected snapshot failure');
      expect(
        (
          await migrationPool.query(
            'SELECT entry_id,display_name FROM published_structure_entry WHERE room_id=$1 ORDER BY entry_id',
            [roomId],
          )
        ).rows,
      ).toEqual(priorSnapshot);
      expect((await revisions()).published_revision).toBe(priorRevision);
      expect(await readPublishedStructure(migrationPool, roomId)).toEqual([]);
    } finally {
      await migrationPool.query(
        'DROP TRIGGER fail_snapshot_insert ON published_structure_entry',
      );
      await migrationPool.query('DROP FUNCTION fail_snapshot_insert()');
    }
  });

  it('denies runtime direct version insertion and requires populated scan/derivative evidence', async () => {
    const forgedDocument = createOpaqueId();
    await runtimePool.query(
      "INSERT INTO document(id,room_id,display_title,created_by) VALUES($1,$2,'Forged',$3)",
      [forgedDocument, roomId, contributorId],
    );
    const forgedVersion = createOpaqueId();
    await expect(
      runtimePool.query(
        `INSERT INTO document_version(id,document_id,original_filename,object_key,
          declared_media_type,size_bytes,state)
         VALUES($1,$2,'forged.pdf',$3,'application/pdf',10,'quarantine')`,
        [forgedVersion, forgedDocument, `quarantine/${createOpaqueId()}/${createOpaqueId()}`],
      ),
    ).rejects.toMatchObject({ code: '42501' });

    const entryId = createOpaqueId();
    const structure = await revisions();
    await runtimePool.query('SELECT create_document_entry($1,$2,NULL,$3,$4,$5,$6,$7,$8)', [
      entryId,
      forgedDocument,
      'Forged',
      8192,
      contributorId,
      structure.working_revision,
      ...audit(),
    ]);
    const currentBeforeQuarantine = await revisions();
    const quarantineVersion = createOpaqueId();
    const quarantineIntent = createOpaqueId();
    await runtimePool.query(
      `INSERT INTO upload_intent
        (id,room_id,member_id,document_id,display_title,original_filename,declared_media_type,
         declared_size,object_key,upload_id,part_plan,state,expires_at)
       VALUES($1,$2,$3,$4,'Forged','quarantine.pdf','application/pdf',10,$5,$6,$7::jsonb,
         'open',transaction_timestamp()+interval '1 hour')`,
      [
        quarantineIntent,
        roomId,
        contributorId,
        forgedDocument,
        `quarantine/${createOpaqueId()}/${createOpaqueId()}`,
        createOpaqueId(),
        '[{"partNumber":1,"size":10}]',
      ],
    );
    await runtimePool.query("UPDATE upload_intent SET state='completing' WHERE id=$1", [
      quarantineIntent,
    ]);
    await runtimePool.query(
      'SELECT create_quarantined_document_version($1,$2,$3,$4,10,$5,$6)',
      [quarantineVersion, forgedDocument, quarantineIntent, contributorId, ...audit()],
    );
    const quarantineDocument = (
      await migrationPool.query<{ revision: number }>(
        'SELECT revision FROM document WHERE id=$1',
        [forgedDocument],
      )
    ).rows[0];
    await expect(
      runtimePool.query('SELECT * FROM update_document_metadata($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
        forgedDocument,
        'Forged',
        '',
        quarantineVersion,
        contributorId,
        quarantineDocument?.revision,
        currentBeforeQuarantine.working_revision,
        ...audit(),
      ]),
    ).rejects.toThrow('working version is not ready');
    expect(
      (
        await migrationPool.query<{ working_version_id: string | null }>(
          'SELECT working_version_id FROM document WHERE id=$1',
          [forgedDocument],
        )
      ).rows[0]?.working_version_id,
    ).toBeNull();

    // Migration-only hostile fixture: a populated ready-looking row has no scan
    // or derivative evidence and therefore cannot even be selected for working publication.
    await migrationPool.query(
      `INSERT INTO document_version(id,document_id,original_filename,object_key,
        declared_media_type,detected_media_type,size_bytes,sha256,state,scan_signature_version)
       VALUES($1,$2,'forged.pdf',$3,'application/pdf','application/pdf',10,$4,
        'ready_for_review','1')`,
      [
        forgedVersion,
        forgedDocument,
        `quarantine/${createOpaqueId()}/${createOpaqueId()}`,
        'a'.repeat(64),
      ],
    );
    const r = await revisions();
    const current = r;
    const d = (
      await migrationPool.query<{ revision: number }>(
        'SELECT revision FROM document WHERE id=$1',
        [forgedDocument],
      )
    ).rows[0];
    await expect(
      runtimePool.query('SELECT * FROM update_document_metadata($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
        forgedDocument,
        'Forged',
        '',
        forgedVersion,
        contributorId,
        d?.revision,
        current.working_revision,
        ...audit(),
      ]),
    ).rejects.toThrow('working version is not ready');
    expect(
      (
        await migrationPool.query<{ working_version_id: string | null }>(
          'SELECT working_version_id FROM document WHERE id=$1',
          [forgedDocument],
        )
      ).rows[0]?.working_version_id,
    ).toBeNull();

    // Bypass the staging function as the migration owner to model a corrupted or
    // legacy row, then prove publication itself independently fails closed.
    await migrationPool.query('UPDATE document SET working_version_id=$2 WHERE id=$1', [
      forgedDocument,
      forgedVersion,
    ]);
    const beforePublish = await revisions();
    const priorSnapshot = await readPublishedStructure(migrationPool, roomId);
    const auditBefore = (
      await runtimePool.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_event')
    ).rows[0]?.n;
    await expect(publish()).rejects.toThrow('document version lacks publication evidence');
    expect((await revisions()).published_revision).toBe(beforePublish.published_revision);
    expect(await readPublishedStructure(migrationPool, roomId)).toEqual(priorSnapshot);
    expect(
      (await runtimePool.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_event'))
        .rows[0]?.n,
    ).toBe(auditBefore);
    await migrationPool.query('UPDATE document SET working_version_id=NULL WHERE id=$1', [
      forgedDocument,
    ]);
    await mutate(entryId, 'Forged', true);
  });

  it('publishes an entire replacement snapshot atomically and records exact version evidence', async () => {
    await publish();
    const before = await revisions();
    await runtimePool.query('SELECT change_room_state($1,$2,$3,$4,$5,$6)', [
      roomId,
      'published',
      managerId,
      before.revision,
      ...audit(),
    ]);
    const visible = await readPublishedStructure(migrationPool, roomId);
    expect(visible.map((item) => item.displayName)).toContain('Working-only rename');
    expect(visible.map((item) => item.displayName)).not.toContain('Published then removed');
    expect(visible.find((item) => item.resourceId === documentId)).toMatchObject({
      displayName: 'Working-only title',
      description: 'Working-only description',
      publishedVersionId: workingVersionId,
    });
    const auditRow = (
      await migrationPool.query<{ detail: { versionIds: readonly string[] } }>(
        "SELECT detail FROM audit_event WHERE reason_code='STRUCTURE_PUBLISHED' AND room_id=$1 ORDER BY sequence DESC LIMIT 1",
        [roomId],
      )
    ).rows[0];
    expect(auditRow?.detail.versionIds).toContain(workingVersionId);
  });
});
