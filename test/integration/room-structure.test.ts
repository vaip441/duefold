import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
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
const ownerId = createOpaqueId();
const managerId = createOpaqueId();
const contributorId = createOpaqueId();
const outsiderId = createOpaqueId();
const roomId = createOpaqueId();

function audit(): readonly [string, string] {
  return [createOpaqueId(), createCorrelationId()];
}
async function room(): Promise<{
  working_revision: number;
  published_revision: number;
  revision: number;
  state: string;
}> {
  const result = await migrationPool.query<{
    working_revision: number;
    published_revision: number;
    revision: number;
    state: string;
  }>('SELECT working_revision,published_revision,revision,state FROM room WHERE id=$1', [
    roomId,
  ]);
  const selected = result.rows[0];
  if (selected === undefined) throw new Error('room absent');
  return selected;
}
async function createFolder(
  parent: string | null,
  name: string,
  order: number,
): Promise<string> {
  const id = createOpaqueId();
  const current = await room();
  await runtimePool.query('SELECT create_folder_entry($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [
    id,
    roomId,
    parent,
    name,
    '',
    order,
    contributorId,
    current.working_revision,
    ...audit(),
  ]);
  return id;
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
      [ownerId, 'structure-owner@example.com', 'owner'],
      [managerId, 'structure-manager@example.com', 'member'],
      [contributorId, 'structure-contributor@example.com', 'member'],
      [outsiderId, 'structure-outsider@example.com', 'member'],
    ] as const)
      await client.query(
        "INSERT INTO member(id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state) VALUES($1,$2,$2,'https://issuer.example',$1,$3,'active')",
        [id, email, role],
      );
    await client.query("INSERT INTO organization(id,name) VALUES($1,'Structure integration')", [
      createOpaqueId(),
    ]);
    await client.query('SELECT create_room($1,$2,$3,$4,$5,$6)', [
      roomId,
      'Investor Room',
      '',
      ownerId,
      ...audit(),
    ]);
    await client.query(
      "INSERT INTO room_assignment(id,room_id,member_id,room_role) VALUES($1,$2,$3,'manager'),($4,$2,$5,'contributor')",
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
  await workerPool.end();
  await migrationPool.end();
  await bootstrapPool.end();
});

describe('room structure database boundary', () => {
  it('accepts legitimate distinct names and rejects canonical/case sibling collisions explicitly', async () => {
    expect(
      (
        await migrationPool.query<{ valid: boolean }>(
          'SELECT valid_structure_text($1,200,false) AS valid',
          ['\u{20BB7}'.repeat(200)],
        )
      ).rows[0]?.valid,
    ).toBe(true);
    expect(
      (
        await migrationPool.query<{ valid: boolean }>(
          'SELECT valid_structure_text($1,200,false) AS valid',
          ['\u{20BB7}'.repeat(201)],
        )
      ).rows[0]?.valid,
    ).toBe(false);
    expect(
      (
        await migrationPool.query<{ valid: boolean }>(
          'SELECT valid_structure_text($1,4000,true) AS valid',
          ['\u{20BB7}'.repeat(4000)],
        )
      ).rows[0]?.valid,
    ).toBe(true);
    expect(
      (
        await migrationPool.query<{ valid: boolean }>(
          'SELECT valid_structure_text($1,4000,true) AS valid',
          ['\u{20BB7}'.repeat(4001)],
        )
      ).rows[0]?.valid,
    ).toBe(false);
    const accepted = [
      '投資家向け資料',
      'Résumé financier (2026)',
      'Доходы 2026 (финал)',
      'Q4 2026',
    ];
    for (const [index, name] of accepted.entries())
      await createFolder(null, name, (index + 1) * 1024);
    expect(
      (
        await migrationPool.query<{ canonical_structure_name: string }>(
          'SELECT canonical_structure_name($1)',
          ['  RE\u0301SUME\u0301 FINANCIER (2026)  '],
        )
      ).rows[0]?.canonical_structure_name,
    ).toBe('résumé financier (2026)');
    expect(
      (
        await migrationPool.query<{ canonical_structure_name: string }>(
          'SELECT canonical_structure_name($1)',
          ['Straße'],
        )
      ).rows[0]?.canonical_structure_name,
    ).toBe('straße');
    const current = await room();
    await expect(
      runtimePool.query('SELECT create_folder_entry($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9)', [
        createOpaqueId(),
        roomId,
        'RE\u0301SUME\u0301 FINANCIER (2026)'.normalize('NFC'),
        '',
        9999,
        contributorId,
        current.working_revision,
        ...audit(),
      ]),
    ).rejects.toMatchObject({ code: '23505' });
    expect(
      (
        await migrationPool.query<{ display_name: string }>(
          'SELECT display_name FROM working_structure_entry WHERE room_id=$1 ORDER BY order_key',
          [roomId],
        )
      ).rows.map((r) => r.display_name),
    ).toEqual(accepted);
  });

  it('rejects rename, move, and restore collisions without suffixing or replacement', async () => {
    const existing = await createFolder(null, 'Collision name', 8000);
    const renameSource = await createFolder(null, 'Rename source', 8001);
    let source = await migrationPool.query<{ revision: number }>(
      'SELECT revision FROM working_structure_entry WHERE id=$1',
      [renameSource],
    );
    let current = await room();
    await expect(
      runtimePool.query(
        'SELECT * FROM mutate_structure_entry($1,NULL,$2,$3,false,$4,$5,$6,$7,$8)',
        [
          renameSource,
          'COLLISION NAME',
          8002,
          contributorId,
          source.rows[0]?.revision,
          current.working_revision,
          ...audit(),
        ],
      ),
    ).rejects.toMatchObject({ code: '23505' });

    const left = await createFolder(null, 'Left destination', 8100);
    const right = await createFolder(null, 'Right destination', 8200);
    const leftChild = await createFolder(left, 'Quarterly model', 1024);
    const rightChild = await createFolder(right, 'Quarterly model', 1024);
    source = await migrationPool.query<{ revision: number }>(
      'SELECT revision FROM working_structure_entry WHERE id=$1',
      [rightChild],
    );
    current = await room();
    await expect(
      runtimePool.query(
        'SELECT * FROM mutate_structure_entry($1,$2,$3,$4,false,$5,$6,$7,$8,$9)',
        [
          rightChild,
          left,
          'Quarterly model',
          2048,
          contributorId,
          source.rows[0]?.revision,
          current.working_revision,
          ...audit(),
        ],
      ),
    ).rejects.toMatchObject({ code: '23505' });

    source = await migrationPool.query<{ revision: number }>(
      'SELECT revision FROM working_structure_entry WHERE id=$1',
      [existing],
    );
    current = await room();
    await runtimePool.query(
      'SELECT * FROM mutate_structure_entry($1,NULL,$2,$3,true,$4,$5,$6,$7,$8)',
      [
        existing,
        'Collision name',
        8000,
        contributorId,
        source.rows[0]?.revision,
        current.working_revision,
        ...audit(),
      ],
    );
    await createFolder(null, 'Collision name', 8300);
    source = await migrationPool.query<{ revision: number }>(
      'SELECT revision FROM working_structure_entry WHERE id=$1',
      [existing],
    );
    current = await room();
    await expect(
      runtimePool.query(
        'SELECT * FROM mutate_structure_entry($1,NULL,$2,$3,false,$4,$5,$6,$7,$8)',
        [
          existing,
          'Collision name',
          8400,
          contributorId,
          source.rows[0]?.revision,
          current.working_revision,
          ...audit(),
        ],
      ),
    ).rejects.toMatchObject({ code: '23505' });

    expect(
      (
        await migrationPool.query<{ display_name: string; parent_folder_id: string | null }>(
          'SELECT display_name,parent_folder_id FROM working_structure_entry WHERE id=ANY($1::text[]) ORDER BY id',
          [[renameSource, leftChild, rightChild, existing]],
        )
      ).rows,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ display_name: 'Rename source' }),
        expect.objectContaining({ display_name: 'Quarterly model', parent_folder_id: left }),
        expect.objectContaining({ display_name: 'Quarterly model', parent_folder_id: right }),
        expect.objectContaining({ display_name: 'Collision name' }),
      ]),
    );
  });

  it('enforces five levels for create and an acyclic descendant-preserving move', async () => {
    let parent: string | null = null;
    for (let level = 1; level <= 5; level += 1)
      parent = await createFolder(parent, `Create depth ${level}`, 10000 + level);
    const current = await room();
    await expect(
      runtimePool.query('SELECT create_folder_entry($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [
        createOpaqueId(),
        roomId,
        parent,
        'Create depth 6',
        '',
        20000,
        contributorId,
        current.working_revision,
        ...audit(),
      ]),
    ).rejects.toThrow('folder depth exceeds five levels');

    const subtreeRoot = await createFolder(null, 'Movable root', 21000);
    await createFolder(subtreeRoot, 'Movable child', 1024);
    let destination: string | null = null;
    for (let level = 1; level <= 4; level += 1)
      destination = await createFolder(destination, `Destination ${level}`, 22000 + level);
    const entryBefore = (
      await migrationPool.query<{ revision: number; parent_folder_id: string | null }>(
        'SELECT revision,parent_folder_id FROM working_structure_entry WHERE id=$1',
        [subtreeRoot],
      )
    ).rows[0];
    if (entryBefore === undefined || destination === null)
      throw new Error('depth fixture absent');
    const roomBefore = await room();
    const auditsBefore = (
      await runtimePool.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_event')
    ).rows[0]?.n;
    await expect(
      runtimePool.query(
        'SELECT * FROM mutate_structure_entry($1,$2,$3,$4,false,$5,$6,$7,$8,$9)',
        [
          subtreeRoot,
          destination,
          'Movable root',
          1024,
          contributorId,
          entryBefore.revision,
          roomBefore.working_revision,
          ...audit(),
        ],
      ),
    ).rejects.toThrow('folder depth exceeds five levels');
    expect(
      (
        await migrationPool.query<{ revision: number; parent_folder_id: string | null }>(
          'SELECT revision,parent_folder_id FROM working_structure_entry WHERE id=$1',
          [subtreeRoot],
        )
      ).rows[0],
    ).toEqual(entryBefore);
    expect((await room()).working_revision).toBe(roomBefore.working_revision);
    expect(
      (await runtimePool.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_event'))
        .rows[0]?.n,
    ).toBe(auditsBefore);
  });

  it('proves the room and entry revision fences independently', async () => {
    const target = await createFolder(null, 'Concurrency target', 30000);
    const selected = (
      await migrationPool.query<{ revision: number; order_key: string }>(
        'SELECT revision,order_key::text FROM working_structure_entry WHERE id=$1',
        [target],
      )
    ).rows[0];
    if (selected === undefined) throw new Error('concurrency fixture absent');
    const current = await room();
    const auditCount = (
      await runtimePool.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_event')
    ).rows[0]?.n;
    await expect(
      runtimePool.query(
        'SELECT * FROM mutate_structure_entry($1,NULL,$2,$3,false,$4,$5,$6,$7,$8)',
        [
          target,
          'Stale room loser',
          selected.order_key,
          contributorId,
          selected.revision,
          current.working_revision - 1,
          ...audit(),
        ],
      ),
    ).rejects.toMatchObject({ code: '40001' });
    await expect(
      runtimePool.query(
        'SELECT * FROM mutate_structure_entry($1,NULL,$2,$3,false,$4,$5,$6,$7,$8)',
        [
          target,
          'Stale entry loser',
          selected.order_key,
          contributorId,
          selected.revision - 1,
          current.working_revision,
          ...audit(),
        ],
      ),
    ).rejects.toMatchObject({ code: '40001' });
    expect((await room()).working_revision).toBe(current.working_revision);
    expect(
      (
        await migrationPool.query<{ display_name: string }>(
          'SELECT display_name FROM working_structure_entry WHERE id=$1',
          [target],
        )
      ).rows[0]?.display_name,
    ).toBe('Concurrency target');
    expect(
      (await runtimePool.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_event'))
        .rows[0]?.n,
    ).toBe(auditCount);
  });

  it('proves folder and document metadata revision fences independently', async () => {
    const folderId = await createFolder(null, 'Metadata folder', 33000);
    const folder = (
      await migrationPool.query<{ revision: number; description: string }>(
        `SELECT e.revision,f.description FROM working_structure_entry e
         JOIN folder f ON f.id=e.folder_id WHERE f.id=$1`,
        [folderId],
      )
    ).rows[0];
    if (folder === undefined) throw new Error('folder metadata fixture absent');
    let current = await room();
    for (const [entryRevision, workingRevision] of [
      [folder.revision, current.working_revision - 1],
      [folder.revision - 1, current.working_revision],
    ] as const)
      await expect(
        runtimePool.query('SELECT * FROM update_folder_description($1,$2,$3,$4,$5,$6,$7)', [
          folderId,
          'must not commit',
          contributorId,
          entryRevision,
          workingRevision,
          ...audit(),
        ]),
      ).rejects.toMatchObject({ code: '40001' });
    expect(
      (
        await migrationPool.query<{ description: string }>(
          'SELECT description FROM folder WHERE id=$1',
          [folderId],
        )
      ).rows[0]?.description,
    ).toBe('');

    const documentId = createOpaqueId();
    await runtimePool.query(
      "INSERT INTO document(id,room_id,display_title,created_by) VALUES($1,$2,'Metadata doc',$3)",
      [documentId, roomId, contributorId],
    );
    current = await room();
    await runtimePool.query('SELECT create_document_entry($1,$2,NULL,$3,$4,$5,$6,$7,$8)', [
      createOpaqueId(),
      documentId,
      'Metadata doc',
      34000,
      contributorId,
      current.working_revision,
      ...audit(),
    ]);
    const document = (
      await migrationPool.query<{ revision: number; description: string }>(
        'SELECT revision,description FROM document WHERE id=$1',
        [documentId],
      )
    ).rows[0];
    if (document === undefined) throw new Error('document metadata fixture absent');
    current = await room();
    for (const [documentRevision, workingRevision] of [
      [document.revision, current.working_revision - 1],
      [document.revision - 1, current.working_revision],
    ] as const)
      await expect(
        runtimePool.query(
          'SELECT * FROM update_document_metadata($1,$2,$3,NULL,$4,$5,$6,$7,$8)',
          [
            documentId,
            'must not commit',
            'must not commit',
            contributorId,
            documentRevision,
            workingRevision,
            ...audit(),
          ],
        ),
      ).rejects.toMatchObject({ code: '40001' });
    expect(
      (
        await migrationPool.query<{ display_title: string; description: string }>(
          'SELECT display_title,description FROM document WHERE id=$1',
          [documentId],
        )
      ).rows[0],
    ).toMatchObject({ display_title: 'Metadata doc', description: '' });
  });

  it('proves publication and room-state revision fences independently', async () => {
    await createFolder(null, 'Publication fence content', 35000);
    const current = await room();
    const snapshotBefore = (
      await migrationPool.query('SELECT * FROM published_structure_entry WHERE room_id=$1', [
        roomId,
      ])
    ).rows;
    for (const [workingRevision, publishedRevision] of [
      [current.working_revision - 1, current.published_revision],
      [current.working_revision, current.published_revision + 1],
    ] as const) {
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
          workingRevision,
          publishedRevision,
          new Date(),
          impact?.confirmation,
          ...audit(),
        ]),
      ).rejects.toMatchObject({ code: '40001' });
    }
    expect((await room()).published_revision).toBe(current.published_revision);
    expect(
      (
        await migrationPool.query('SELECT * FROM published_structure_entry WHERE room_id=$1', [
          roomId,
        ])
      ).rows,
    ).toEqual(snapshotBefore);

    const impact = (
      await runtimePool.query<{ dry_run_bulk_publish: { confirmation: string } }>(
        'SELECT dry_run_bulk_publish($1,$2)',
        [managerId, roomId],
      )
    ).rows[0]?.dry_run_bulk_publish;
    await runtimePool.query('SELECT apply_bulk_publish($1,$2,$3,$4,$5,$6,$7,$8)', [
      managerId,
      roomId,
      current.working_revision,
      current.published_revision,
      new Date(),
      impact?.confirmation,
      ...audit(),
    ]);
    const publishable = await room();
    await expect(
      runtimePool.query('SELECT change_room_state($1,$2,$3,$4,$5,$6)', [
        roomId,
        'published',
        managerId,
        publishable.revision - 1,
        ...audit(),
      ]),
    ).rejects.toMatchObject({ code: '40001' });
    expect((await room()).state).toBe('draft');
  });

  it('authorizes contributor writes but reserves publication for managers', async () => {
    const current = await room();
    await expect(
      runtimePool.query('SELECT create_folder_entry($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9)', [
        createOpaqueId(),
        roomId,
        'Outsider',
        '',
        40000,
        outsiderId,
        current.working_revision,
        ...audit(),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      runtimePool.query('SELECT dry_run_bulk_publish($1,$2)', [contributorId, roomId]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('rebalances a bounded sibling set transactionally and audits it', async () => {
    const first = await createFolder(null, 'Rebalance A', 50001);
    const second = await createFolder(null, 'Rebalance B', 50002);
    const current = await room();
    await runtimePool.query('SELECT rebalance_structure_siblings($1,NULL,$2,$3,$4,$5)', [
      roomId,
      contributorId,
      current.working_revision,
      ...audit(),
    ]);
    const keys = (
      await migrationPool.query<{ order_key: string }>(
        'SELECT order_key::text FROM working_structure_entry WHERE id=ANY($1::text[]) ORDER BY order_key',
        [[first, second]],
      )
    ).rows.map((r) => r.order_key);
    expect(Number(keys[1]) - Number(keys[0])).toBeGreaterThanOrEqual(1024);
    expect(
      (
        await migrationPool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM audit_event WHERE reason_code='ORDER_REBALANCED' AND room_id=$1",
          [roomId],
        )
      ).rows[0]?.n,
    ).toBe(1);
  });

  it('rolls the security mutation back when append-only audit persistence fails', async () => {
    const current = await room();
    await migrationPool.query(
      `CREATE FUNCTION fail_structure_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.reason_code='FOLDER_CREATED' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $$`,
    );
    await migrationPool.query(
      'CREATE TRIGGER fail_structure_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION fail_structure_audit()',
    );
    const id = createOpaqueId();
    try {
      await expect(
        runtimePool.query('SELECT create_folder_entry($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9)', [
          id,
          roomId,
          'Must roll back',
          '',
          60000,
          contributorId,
          current.working_revision,
          ...audit(),
        ]),
      ).rejects.toThrow('injected audit failure');
      expect(
        (
          await migrationPool.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM folder WHERE id=$1',
            [id],
          )
        ).rows[0]?.n,
      ).toBe(0);
      expect((await room()).working_revision).toBe(current.working_revision);
    } finally {
      await migrationPool.query('DROP TRIGGER fail_structure_audit ON audit_event');
      await migrationPool.query('DROP FUNCTION fail_structure_audit()');
    }
  });

  it('denies runtime table-wide reads of populated draft structure while narrow readers work', async () => {
    // The room and structure are populated by prior positive tests. A blank table
    // would make this denial vacuous.
    expect((await room()).working_revision).toBeGreaterThan(1);
    for (const table of [
      'room',
      'document',
      'folder',
      'working_structure_entry',
      'published_structure_entry',
    ])
      await expect(runtimePool.query(`SELECT * FROM ${table} LIMIT 1`)).rejects.toMatchObject({
        code: '42501',
      });
  });

  it('denies runtime direct writes to snapshots and worker structure capabilities', async () => {
    await expect(
      runtimePool.query(
        "INSERT INTO published_structure_entry(room_id,entry_id,resource_kind,resource_id,display_name,description,order_key,source_revision) VALUES($1,$2,'folder',$2,'forged','',1,1)",
        [roomId, createOpaqueId()],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      workerPool.query('SELECT create_folder_entry($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9)', [
        createOpaqueId(),
        roomId,
        'worker',
        '',
        70000,
        contributorId,
        (await room()).working_revision,
        ...audit(),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
