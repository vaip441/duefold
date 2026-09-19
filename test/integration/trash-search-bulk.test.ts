import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import { createHandler as createTrashPurgeHandler } from '../../modules/rooms-documents/src/jobs/trash-purge.ts';
import type { WorkerStorage } from '../../modules/rooms-documents/src/storage/s3-compatible.ts';
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
  managerId = createOpaqueId(),
  contributorId = createOpaqueId(),
  outsiderId = createOpaqueId();
const roomId = createOpaqueId(),
  otherRoomId = createOpaqueId();
function audit(): readonly [string, string] {
  return [createOpaqueId(), createCorrelationId()];
}
async function revisions(id = roomId) {
  const row = (
    await migrationPool.query<{
      working_revision: number;
      published_revision: number;
      revision: number;
    }>('SELECT working_revision,published_revision,revision FROM room WHERE id=$1', [id])
  ).rows[0];
  if (!row) throw new Error('ROOM_ABSENT');
  return row;
}
async function folder(
  id: string,
  name: string,
  order: number,
  room = roomId,
  actor = contributorId,
) {
  const r = await revisions(room);
  await runtimePool.query('SELECT create_folder_entry($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9)', [
    id,
    room,
    name,
    `${name} kirjeldus`,
    order,
    actor,
    r.working_revision,
    ...audit(),
  ]);
}
async function entry(id: string) {
  const row = (
    await migrationPool.query<{ revision: number; order_key: string; staged_removed: boolean }>(
      'SELECT revision,order_key::text,staged_removed FROM working_structure_entry WHERE id=$1',
      [id],
    )
  ).rows[0];
  if (!row) throw new Error('ENTRY_ABSENT');
  return row;
}
async function fullDatabaseState(): Promise<string> {
  const relations = (
    await migrationPool.query<{ name: string }>(
      `SELECT c.relname name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname`,
    )
  ).rows.map((row) => row.name);
  const tables: Record<string, readonly unknown[]> = {};
  for (const name of relations) {
    if (!/^[a-z_][a-z0-9_]*$/u.test(name)) throw new Error('UNSAFE_RELATION');
    tables[name] = (
      await migrationPool.query<{ value: unknown }>(
        `SELECT to_jsonb(t) value FROM ${name} t ORDER BY to_jsonb(t)::text`,
      )
    ).rows.map((row) => row.value);
  }
  const sequenceNames = (
    await migrationPool.query<{ name: string }>(
      `SELECT c.relname name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind='S' ORDER BY c.relname`,
    )
  ).rows.map((row) => row.name);
  const sequences: Record<string, { lastValue: string; isCalled: boolean }> = {};
  for (const name of sequenceNames) {
    if (!/^[a-z_][a-z0-9_]*$/u.test(name)) throw new Error('UNSAFE_SEQUENCE');
    const state = (
      await migrationPool.query<{ last_value: string; is_called: boolean }>(
        `SELECT last_value::text,is_called FROM ${name}`,
      )
    ).rows[0];
    if (state === undefined) throw new Error('SEQUENCE_STATE_ABSENT');
    sequences[name] = { lastValue: state.last_value, isCalled: state.is_called };
  }
  return JSON.stringify({ tables, sequences });
}
async function remove(id: string) {
  const e = await entry(id),
    r = await revisions();
  await runtimePool.query(
    'SELECT * FROM mutate_structure_entry($1,NULL,$2,$3,true,$4,$5,$6,$7,$8)',
    [
      id,
      (
        await migrationPool.query<{ display_name: string }>(
          'SELECT display_name FROM working_structure_entry WHERE id=$1',
          [id],
        )
      ).rows[0]?.display_name,
      e.order_key,
      contributorId,
      e.revision,
      r.working_revision,
      ...audit(),
    ],
  );
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
      [ownerId, 'w2-owner@example.com', 'owner'],
      [managerId, 'w2-manager@example.com', 'member'],
      [contributorId, 'w2-contributor@example.com', 'member'],
      [outsiderId, 'w2-outsider@example.com', 'member'],
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
      'Investor Room Eesti',
      'Põhiandmed',
      ownerId,
      ...audit(),
    ]);
    await c.query('SELECT create_room($1,$2,$3,$4,$5,$6)', [
      otherRoomId,
      'Secret Other Room',
      'Cross room marker',
      ownerId,
      ...audit(),
    ]);
    await c.query(
      "INSERT INTO room_assignment(id,room_id,member_id,room_role) VALUES($1,$2,$3,'manager'),($4,$2,$5,'contributor'),($6,$7,$5,'contributor')",
      [
        createOpaqueId(),
        roomId,
        managerId,
        createOpaqueId(),
        contributorId,
        createOpaqueId(),
        otherRoomId,
      ],
    );
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
});
afterAll(async () => {
  await runtimePool.end();
  await workerPool.end();
  await migrationPool.end();
  await bootstrapPool.end();
});

describe('trash, search, and bulk database boundary', () => {
  it('searches legitimate metadata but never leaks a populated unauthorized room', async () => {
    const estonian = createOpaqueId(),
      cyrillic = createOpaqueId(),
      cjk = createOpaqueId(),
      secret = createOpaqueId();
    await folder(estonian, 'Äriplaan (2026)', 1000);
    await folder(cyrillic, 'Доходы 2026-финал', 2000);
    await folder(cjk, '投資家向け資料 2026', 3000);
    await folder(secret, 'Cross-room-secret-2026', 1000, otherRoomId, contributorId);
    const extraNames = [
      '-2026 Leading digits',
      'Revenue-2026',
      'Investor 📈 Plan 2026',
      'Résumé (définitif)',
      `Long ${'aruande '.repeat(20)}lõpp`,
      'Café Årsrapport',
    ] as const;
    for (const [index, name] of extraNames.entries())
      await folder(createOpaqueId(), name, 3100 + index);
    const searches: readonly [string, string][] = [
      ['äriplaan', 'Äriplaan (2026)'],
      ['доходы', 'Доходы 2026-финал'],
      ['финал', 'Доходы 2026-финал'],
      ['投資家向け資料', '投資家向け資料 2026'],
      ['2026', 'Revenue-2026'],
      ['2026', '-2026 Leading digits'],
      ['📈', 'Investor 📈 Plan 2026'],
      ['résumé', 'Résumé (définitif)'],
      // Byte-distinct decomposed accents must find NFC metadata. These literals
      // are intentionally NOT normalized by the test; canonical_search_text is
      // the sole normalization boundary used by both indexes and query arms.
      ['re\u0301sume\u0301', 'Résumé (définitif)'],
      ['cafe\u0301 a\u030arsrapport', 'Café Årsrapport'],
      ['café årsrapport', 'Café Årsrapport'],
      ['définitif', 'Résumé (définitif)'],
      ['lõpp', extraNames[4]],
    ];
    for (const [query, expected] of searches) {
      const found = (
        await runtimePool.query<{ display_name: string }>(
          'SELECT display_name FROM member_search_room($1,$2,$3,100)',
          [contributorId, roomId, query],
        )
      ).rows.map((row) => row.display_name);
      expect(found, `query ${query}`).toContain(expected);
      expect(found, `query ${query} must not cross rooms`).not.toContain(
        'Cross-room-secret-2026',
      );
    }
    expect(
      (
        await runtimePool.query<{ display_name: string }>(
          'SELECT * FROM member_search_room($1,$2,$3,100)',
          [outsiderId, roomId, '2026'],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await runtimePool.query<{ display_name: string }>(
          'SELECT * FROM member_search_room($1,$2,$3,100)',
          [contributorId, otherRoomId, 'secret'],
        )
      ).rows.map((r) => r.display_name),
    ).toContain('Cross-room-secret-2026');

    /*
     * EXPLAIN the actual per-table matching statement used by member_search_room,
     * not a standalone one-column probe. Disabling sequential scans does not
     * force a nonexistent index path: a mismatched expression would remain a
     * Seq Scan with prohibitive cost. The room predicate is present in every arm
     * exactly as it is in the SECURITY DEFINER function, after its authorization
     * gate has succeeded.
     */
    const explainClient = await migrationPool.connect();
    let plan: string;
    const planSuffix = createOpaqueId().slice(0, 8);
    try {
      await explainClient.query('BEGIN');
      // A realistic room cardinality prevents the tiny functional fixture from
      // making its existing btree room index look cheaper than the GIN search
      // indexes. The rows are transaction-local and rolled back with EXPLAIN.
      await explainClient.query(
        `WITH ids AS (
           SELECT g,'${planSuffix}' || lpad(g::text,24,'0') folder_id,
             '${planSuffix}' || lpad((g+1000)::text,24,'0') entry_id
           FROM generate_series(1,1000) g
         )
         INSERT INTO folder(id,room_id,description,created_by)
         SELECT folder_id,$1,'Plan decoy '||g,$2 FROM ids`,
        [roomId, contributorId],
      );
      await explainClient.query(
        `WITH ids AS (
           SELECT g,'${planSuffix}' || lpad(g::text,24,'0') folder_id,
             '${planSuffix}' || lpad((g+1000)::text,24,'0') entry_id
           FROM generate_series(1,1000) g
         )
         INSERT INTO working_structure_entry(id,room_id,folder_id,display_name,order_key)
         SELECT entry_id,$1,folder_id,'Plan decoy '||g,100000+g FROM ids`,
        [roomId],
      );
      await explainClient.query(
        'ANALYZE working_structure_entry; ANALYZE folder; ANALYZE document',
      );
      await explainClient.query('SET LOCAL enable_seqscan=off');
      await explainClient.query('SET LOCAL enable_indexscan=off');
      const functionSource = (
        await explainClient.query<{ source: string }>(
          `SELECT p.prosrc source FROM pg_proc p
           WHERE p.oid='zero_lexeme_member_search(text,text,integer)'::regprocedure`,
        )
      ).rows[0]?.source;
      if (functionSource === undefined) throw new Error('SEARCH_FUNCTION_SOURCE_ABSENT');
      const explainableSource = functionSource
        .replace(/\bp_room_id\b/gu, '$1')
        .replace(/\bp_query\b/gu, '$2')
        .replace(/\bp_limit\b/gu, '$3');
      plan = (
        await explainClient.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN (COSTS OFF) ${explainableSource}`,
          [roomId, '📈', 100],
        )
      ).rows
        .map((row) => row['QUERY PLAN'])
        .join('\n');
      await explainClient.query('ROLLBACK');
    } finally {
      explainClient.release();
    }
    expect(plan).toMatch(/working_name_substring/u);
    expect(plan).toMatch(/folder_description_substring/u);
    expect(plan).toMatch(/document_metadata_substring/u);
    expect(plan).not.toMatch(/Seq Scan on (?:working_structure_entry|folder|document)\b/u);
  });

  it('moves draft-only content to fixed trash immediately, frees the name, and restores only to an explicit conflict-free name', async () => {
    const trashed = createOpaqueId();
    await folder(trashed, 'Quarterly Model', 4000);
    await remove(trashed);
    const trash = (
      await migrationPool.query<{ id: string; purge_after: Date; trashed_at: Date }>(
        'SELECT id,purge_after,trashed_at FROM room_trash WHERE root_entry_id=$1',
        [trashed],
      )
    ).rows[0];
    if (!trash) throw new Error('TRASH_ABSENT');
    expect(trash.purge_after.getTime() - trash.trashed_at.getTime()).toBe(
      30 * 24 * 60 * 60 * 1000,
    );
    await expect(
      migrationPool.query(
        "UPDATE room_trash SET purge_after=trashed_at+interval '29 days' WHERE id=$1",
        [trash.id],
      ),
    ).rejects.toThrow('trash retention is fixed');
    await expect(
      runtimePool.query(
        'UPDATE room_trash SET purge_after=transaction_timestamp() WHERE id=$1',
        [trash.id],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await folder(createOpaqueId(), 'Quarterly Model', 4100);
    let e = await entry(trashed),
      r = await revisions();
    await expect(
      runtimePool.query('SELECT * FROM restore_trash_entry($1,NULL,$2,4200,$3,$4,$5,$6,$7)', [
        trash.id,
        'Quarterly Model',
        managerId,
        e.revision,
        r.working_revision,
        ...audit(),
      ]),
    ).rejects.toMatchObject({ code: '23505' });
    expect((await entry(trashed)).staged_removed).toBe(true);
    e = await entry(trashed);
    r = await revisions();
    /*
     * Restore is MANAGER-ONLY: trash restore is among Room Manager powers and
     * excluded from the Contributor's. Populated negative arm first -- the
     * Contributor is refused on the very same trash row the Manager then restores
     * successfully, so this cannot pass because the row is missing, expired, or
     * already restored.
     */
    await expect(
      runtimePool.query('SELECT * FROM restore_trash_entry($1,NULL,$2,4200,$3,$4,$5,$6,$7)', [
        trash.id,
        'Kvartalimudel 2026 (taastatud)',
        contributorId,
        e.revision,
        r.working_revision,
        ...audit(),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await runtimePool.query(
      'SELECT * FROM restore_trash_entry($1,NULL,$2,4200,$3,$4,$5,$6,$7)',
      [
        trash.id,
        'Kvartalimudel 2026 (taastatud)',
        managerId,
        e.revision,
        r.working_revision,
        ...audit(),
      ],
    );
    expect(await entry(trashed)).toMatchObject({ staged_removed: false });
    expect(
      (await migrationPool.query('SELECT 1 FROM room_trash WHERE id=$1', [trash.id])).rowCount,
    ).toBe(0);
    expect(
      (
        await migrationPool.query<{ display_name: string }>(
          'SELECT display_name FROM working_structure_entry WHERE id=$1',
          [trashed],
        )
      ).rows[0]?.display_name,
    ).toBe('Kvartalimudel 2026 (taastatud)');
  });

  it('keeps a published removal visible until publication, restores only to draft, and preserves member assignments', async () => {
    const id = createOpaqueId();
    await folder(id, 'Published then removed', 5000);
    let r = await revisions();
    let impact = (
      await runtimePool.query<{ dry_run_bulk_publish: { confirmation: string } }>(
        'SELECT dry_run_bulk_publish($1,$2)',
        [managerId, roomId],
      )
    ).rows[0]?.dry_run_bulk_publish;
    await runtimePool.query('SELECT apply_bulk_publish($1,$2,$3,$4,$5,$6,$7,$8)', [
      managerId,
      roomId,
      r.working_revision,
      r.published_revision,
      new Date(),
      impact?.confirmation,
      ...audit(),
    ]);
    expect(
      (
        await migrationPool.query<{ display_name: string }>(
          'SELECT display_name FROM published_structure_entry WHERE entry_id=$1',
          [id],
        )
      ).rows[0]?.display_name,
    ).toBe('Published then removed');
    const assignmentsBefore = (
      await migrationPool.query(
        'SELECT id,room_id,member_id,room_role,state,created_at FROM room_assignment WHERE room_id=$1 ORDER BY id',
        [roomId],
      )
    ).rows;
    await remove(id);
    expect(
      (
        await migrationPool.query<{ display_name: string }>(
          'SELECT display_name FROM published_structure_entry WHERE entry_id=$1',
          [id],
        )
      ).rows[0]?.display_name,
    ).toBe('Published then removed');
    expect(
      (await migrationPool.query('SELECT 1 FROM room_trash WHERE root_entry_id=$1', [id]))
        .rowCount,
    ).toBe(0);
    r = await revisions();
    impact = (
      await runtimePool.query<{ dry_run_bulk_publish: { confirmation: string } }>(
        'SELECT dry_run_bulk_publish($1,$2)',
        [managerId, roomId],
      )
    ).rows[0]?.dry_run_bulk_publish;
    await runtimePool.query('SELECT apply_bulk_publish($1,$2,$3,$4,$5,$6,$7,$8)', [
      managerId,
      roomId,
      r.working_revision,
      r.published_revision,
      new Date(),
      impact?.confirmation,
      ...audit(),
    ]);
    expect(
      (
        await migrationPool.query('SELECT 1 FROM published_structure_entry WHERE entry_id=$1', [
          id,
        ])
      ).rowCount,
    ).toBe(0);
    const trash = (
      await migrationPool.query<{ id: string }>(
        'SELECT id FROM room_trash WHERE root_entry_id=$1',
        [id],
      )
    ).rows[0];
    if (!trash) throw new Error('TRASH_ABSENT');
    const e = await entry(id);
    r = await revisions();
    await runtimePool.query(
      'SELECT * FROM restore_trash_entry($1,NULL,$2,5100,$3,$4,$5,$6,$7)',
      [
        trash.id,
        'Published restored draft',
        managerId,
        e.revision,
        r.working_revision,
        ...audit(),
      ],
    );
    expect(await entry(id)).toMatchObject({ staged_removed: false });
    expect(
      (
        await migrationPool.query('SELECT 1 FROM published_structure_entry WHERE entry_id=$1', [
          id,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await migrationPool.query(
          'SELECT id,room_id,member_id,room_role,state,created_at FROM room_assignment WHERE room_id=$1 ORDER BY id',
          [roomId],
        )
      ).rows,
    ).toEqual(assignmentsBefore);
  });

  it('makes dry-run side-effect free and bulk move all-or-nothing with per-item success', async () => {
    const destination = createOpaqueId(),
      a = createOpaqueId(),
      b = createOpaqueId();
    await folder(destination, 'Bulk destination', 6000);
    await folder(a, 'Move A', 6100);
    await folder(b, 'Move B', 6200);
    const ea = await entry(a),
      eb = await entry(b),
      before = await revisions();
    const items = [
      { entryId: a, expectedEntryRevision: ea.revision, orderKey: 1024 },
      { entryId: b, expectedEntryRevision: eb.revision, orderKey: 2048 },
    ];
    const stateBeforeMoveDryRun = await fullDatabaseState();
    const impact = (
      await runtimePool.query<{
        dry_run_bulk_move: { affectedCount: number; confirmation: string };
      }>('SELECT dry_run_bulk_move($1,$2,$3,$4::jsonb)', [
        contributorId,
        roomId,
        destination,
        JSON.stringify(items),
      ])
    ).rows[0]?.dry_run_bulk_move;
    expect(impact?.affectedCount).toBe(2);
    expect(await fullDatabaseState()).toBe(stateBeforeMoveDryRun);
    expect((await revisions()).working_revision).toBe(before.working_revision);
    expect((await entry(a)).revision).toBe(ea.revision);
    await migrationPool.query(
      `CREATE FUNCTION fail_bulk_audit_after_apply() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN IF NEW.reason_code='BULK_MOVE_APPLIED' THEN RAISE EXCEPTION 'injected post-batch failure'; END IF; RETURN NEW; END $$`,
    );
    // AFTER INSERT guarantees room revision, every structure row, and the audit
    // insert have all happened before failure; rollback must undo all of them.
    await migrationPool.query(
      'CREATE TRIGGER fail_bulk_audit_after_apply AFTER INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION fail_bulk_audit_after_apply()',
    );
    const auditBeforeFailure = (
      await migrationPool.query<{ count: number }>(
        'SELECT count(*)::int count FROM audit_event',
      )
    ).rows[0]?.count;
    try {
      await expect(
        runtimePool.query('SELECT apply_bulk_move($1,$2,$3,$4::jsonb,$5,$6,$7,$8)', [
          contributorId,
          roomId,
          destination,
          JSON.stringify(items),
          before.working_revision,
          impact?.confirmation,
          ...audit(),
        ]),
      ).rejects.toThrow('injected post-batch failure');
    } finally {
      await migrationPool.query('DROP TRIGGER fail_bulk_audit_after_apply ON audit_event');
      await migrationPool.query('DROP FUNCTION fail_bulk_audit_after_apply()');
    }
    expect((await revisions()).working_revision).toBe(before.working_revision);
    expect(await entry(a)).toEqual(ea);
    expect(await entry(b)).toEqual(eb);
    expect(
      (
        await migrationPool.query<{ count: number }>(
          'SELECT count(*)::int count FROM audit_event',
        )
      ).rows[0]?.count,
    ).toBe(auditBeforeFailure);
    expect(
      (
        await migrationPool.query<{ parent_folder_id: string | null }>(
          'SELECT parent_folder_id FROM working_structure_entry WHERE id=ANY($1::text[]) ORDER BY id',
          [[a, b]],
        )
      ).rows.every((x) => x.parent_folder_id === null),
    ).toBe(true);
    const applied = (
      await runtimePool.query<{ apply_bulk_move: { items: readonly { status: string }[] } }>(
        'SELECT apply_bulk_move($1,$2,$3,$4::jsonb,$5,$6,$7,$8)',
        [
          contributorId,
          roomId,
          destination,
          JSON.stringify(items),
          before.working_revision,
          impact?.confirmation,
          ...audit(),
        ],
      )
    ).rows[0]?.apply_bulk_move;
    expect(applied?.items.map((x) => x.status)).toEqual(['moved', 'moved']);
  });

  it('requires manager, fresh OIDC, exact confirmation, and revisions for guarded bulk publish', async () => {
    const id = createOpaqueId();
    await folder(id, 'Guarded publish', 7000);
    const r = await revisions();
    const impact = (
      await runtimePool.query<{
        dry_run_bulk_publish: { confirmation: string; affectedCount: number };
      }>('SELECT dry_run_bulk_publish($1,$2)', [managerId, roomId])
    ).rows[0]?.dry_run_bulk_publish;
    expect(impact?.affectedCount).toBeGreaterThan(0);
    const publishStateBefore = await fullDatabaseState();
    const secondImpact = (
      await runtimePool.query<{ dry_run_bulk_publish: unknown }>(
        'SELECT dry_run_bulk_publish($1,$2)',
        [managerId, roomId],
      )
    ).rows[0]?.dry_run_bulk_publish;
    expect(secondImpact).toEqual(impact);
    expect(await fullDatabaseState()).toBe(publishStateBefore);
    await expect(
      runtimePool.query('SELECT apply_bulk_publish($1,$2,$3,$4,$5,$6,$7,$8)', [
        contributorId,
        roomId,
        r.working_revision,
        r.published_revision,
        new Date(),
        'bad',
        ...audit(),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      runtimePool.query('SELECT apply_bulk_publish($1,$2,$3,$4,$5,$6,$7,$8)', [
        managerId,
        roomId,
        r.working_revision,
        r.published_revision,
        new Date(Date.now() - 16 * 60_000),
        impact?.confirmation,
        ...audit(),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      runtimePool.query('SELECT apply_bulk_publish($1,$2,$3,$4,$5,$6,$7,$8)', [
        managerId,
        roomId,
        r.working_revision,
        r.published_revision,
        new Date(),
        'wrong confirmation',
        ...audit(),
      ]),
    ).rejects.toMatchObject({ code: '22023' });
    const applied = (
      await runtimePool.query<{ apply_bulk_publish: { publishedRevision: number } }>(
        'SELECT apply_bulk_publish($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          managerId,
          roomId,
          r.working_revision,
          r.published_revision,
          new Date(),
          impact?.confirmation,
          ...audit(),
        ],
      )
    ).rows[0]?.apply_bulk_publish;
    expect(applied?.publishedRevision).toBe(r.published_revision + 1);
  });

  it('rejects stale purge leases before storage or database deletion, then purges with the exact lease', async () => {
    const documentId = createOpaqueId();
    const entryId = createOpaqueId();
    const versionId = createOpaqueId();
    const sourceKey = `quarantine/${createOpaqueId()}/${createOpaqueId()}`;
    await runtimePool.query(
      "INSERT INTO document(id,room_id,display_title,created_by) VALUES($1,$2,'Purge target',$3)",
      [documentId, roomId, contributorId],
    );
    await migrationPool.query(
      `INSERT INTO document_version(id,document_id,original_filename,object_key,declared_media_type,size_bytes,state)
       VALUES($1,$2,'purge.pdf',$3,'application/pdf',10,'quarantine')`,
      [versionId, documentId, sourceKey],
    );
    const attachRevision = await revisions();
    await runtimePool.query('SELECT create_document_entry($1,$2,NULL,$3,8000,$4,$5,$6,$7)', [
      entryId,
      documentId,
      'Purge target',
      contributorId,
      attachRevision.working_revision,
      ...audit(),
    ]);
    await remove(entryId);
    const trash = (
      await migrationPool.query<{ id: string; purge_after: Date }>(
        'SELECT id,purge_after FROM room_trash WHERE root_entry_id=$1',
        [entryId],
      )
    ).rows[0];
    if (!trash) throw new Error('TRASH_ABSENT');
    const job = (
      await migrationPool.query<{ id: string }>(
        "SELECT id FROM job_queue WHERE job_type=$1 AND payload->>'trashId'=$2",
        ['room.trash.purge', trash.id],
      )
    ).rows[0];
    if (!job) throw new Error('JOB_ABSENT');
    const owner = createOpaqueId(),
      token = createOpaqueId(),
      wrong = createOpaqueId();
    await migrationPool.query(
      "UPDATE job_queue SET state='running',attempts=1,lease_owner=$2,lease_token=$3,lease_expires_at=transaction_timestamp()+interval '1 hour' WHERE id=$1",
      [job.id, owner, token],
    );
    await expect(
      workerPool.query('SELECT object_key FROM begin_trash_purge($1,$2,$3,$4)', [
        trash.id,
        job.id,
        owner,
        token,
      ]),
    ).rejects.toThrow('trash purge lease lost or retention active');
    // Migration-only time travel fixture: production callers cannot change these
    // columns (proved above), but the worker success arm needs a row already past
    // the fixed clock boundary without waiting 30 days.
    await migrationPool.query('ALTER TABLE room_trash DISABLE TRIGGER fixed_trash_retention');
    try {
      await migrationPool.query(
        "UPDATE room_trash SET trashed_at=transaction_timestamp()-interval '31 days',purge_after=transaction_timestamp()-interval '1 day' WHERE id=$1",
        [trash.id],
      );
    } finally {
      await migrationPool.query('ALTER TABLE room_trash ENABLE TRIGGER fixed_trash_retention');
    }
    const deleted: string[] = [];
    const storage: WorkerStorage = {
      checksumSupport: true,
      checkReady: () => Promise.resolve(),
      createMultipart: () => Promise.reject(new Error('UNUSED')),
      presignPart: () => Promise.reject(new Error('UNUSED')),
      completeMultipart: () => Promise.reject(new Error('UNUSED')),
      abortMultipart: () => Promise.reject(new Error('UNUSED')),
      headObject: () => Promise.reject(new Error('UNUSED')),
      deleteObject: (key: string) => {
        deleted.push(key);
        return Promise.resolve();
      },
      getObjectBytes: () => Promise.reject(new Error('UNUSED')),
      streamObject: () => Promise.reject(new Error('UNUSED')),
      putExportStream: () => Promise.reject(new Error('UNUSED')),
      putBrandingAsset: () => Promise.reject(new Error('UNUSED')),
      putSystemDeletionMarker: () => Promise.reject(new Error('UNUSED')),
      putDerivative: () => Promise.reject(new Error('UNUSED')),
    };
    const handler = createTrashPurgeHandler({ pool: workerPool, storage });
    const leased = {
      id: job.id,
      job_type: 'room.trash.purge',
      payload: { trashId: trash.id },
      attempts: 1,
      max_attempts: 5,
      lease_token: wrong,
    };
    await expect(
      handler(leased, {
        leaseOwner: owner,
        signal: new AbortController().signal,
        assertLease: () => Promise.resolve(),
      }),
    ).rejects.toThrow('trash purge lease lost');
    expect(deleted).toEqual([]);
    expect(
      (await migrationPool.query('SELECT 1 FROM room_trash WHERE id=$1', [trash.id])).rowCount,
    ).toBe(1);
    await handler(
      { ...leased, lease_token: token },
      {
        leaseOwner: owner,
        signal: new AbortController().signal,
        assertLease: () => Promise.resolve(),
      },
    );
    expect(
      (await migrationPool.query('SELECT 1 FROM room_trash WHERE id=$1', [trash.id])).rowCount,
    ).toBe(0);
    expect(
      (await migrationPool.query('SELECT 1 FROM document WHERE id=$1', [documentId])).rowCount,
    ).toBe(0);
    expect(
      (await migrationPool.query('SELECT 1 FROM document_version WHERE id=$1', [versionId]))
        .rowCount,
    ).toBe(0);
    expect(deleted).toContain(sourceKey);
    expect(
      (
        await migrationPool.query<{ detail: { retentionDays: number } }>(
          "SELECT detail FROM audit_event WHERE reason_code='TRASH_PURGED' ORDER BY sequence DESC LIMIT 1",
        )
      ).rows[0]?.detail,
    ).toEqual({ retentionDays: 30 });
  });

  it('restores trashed content to working state without resurrecting its viewer grants', async () => {
    /*
     * A real active viewer grant targets the same folder that is trashed. The
     * trash trigger revokes it; restore then brings the content back to working
     * state but MUST NOT reactivate or recreate the grant. Both outcomes are
     * asserted after the same restore, so this cannot pass against missing
     * content/grants.
     */
    const folderId = createOpaqueId(),
      viewerId = createOpaqueId(),
      grantId = createOpaqueId();
    await migrationPool.query(
      "INSERT INTO viewer(id,email_key,email_display,state,session_family_id) VALUES($1,$2,$2,'active',$3)",
      [viewerId, 'trash-grant@example.com', createOpaqueId()],
    );
    let r = await revisions();
    await runtimePool.query('SELECT add_viewer_to_room($1,$2,$3,$4,$5,$6,$7)', [
      createOpaqueId(),
      viewerId,
      roomId,
      managerId,
      r.revision,
      ...audit(),
    ]);
    await folder(folderId, 'Granted then trashed', 9100);
    const grantArgs = [
      managerId,
      roomId,
      'grant',
      grantId,
      'viewer',
      viewerId,
      null,
      'folder',
      folderId,
      null,
      null,
    ];
    const preview = (
      await runtimePool.query<{
        dry_run_grant_change: { confirmation: string; affectedCount: number };
      }>('SELECT dry_run_grant_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', grantArgs)
    ).rows[0]?.dry_run_grant_change;
    expect(preview?.affectedCount).toBe(1);
    r = await revisions();
    await runtimePool.query(
      'SELECT apply_grant_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
      [...grantArgs, r.revision, new Date(), preview?.confirmation, ...audit()],
    );
    expect(
      (
        await migrationPool.query<{ state: string }>(
          'SELECT state FROM access_grant WHERE id=$1',
          [grantId],
        )
      ).rows[0]?.state,
    ).toBe('active');

    await remove(folderId);
    const trash = (
      await migrationPool.query<{ id: string }>(
        'SELECT id FROM room_trash WHERE root_entry_id=$1',
        [folderId],
      )
    ).rows[0];
    if (!trash) throw new Error('GRANTED_TRASH_ABSENT');
    expect(
      (
        await migrationPool.query<{ state: string }>(
          'SELECT state FROM access_grant WHERE id=$1',
          [grantId],
        )
      ).rows[0]?.state,
    ).toBe('revoked');

    const e = await entry(folderId);
    r = await revisions();
    await runtimePool.query(
      'SELECT * FROM restore_trash_entry($1,NULL,$2,9100,$3,$4,$5,$6,$7)',
      [
        trash.id,
        'Granted then restored',
        managerId,
        e.revision,
        r.working_revision,
        ...audit(),
      ],
    );
    expect(await entry(folderId)).toMatchObject({ staged_removed: false });
    expect(
      (
        await migrationPool.query<{ state: string }>(
          'SELECT state FROM access_grant WHERE id=$1',
          [grantId],
        )
      ).rows[0]?.state,
    ).toBe('revoked');
    expect(
      (
        await migrationPool.query('SELECT 1 FROM access_grant WHERE id<>$1 AND folder_id=$2', [
          grantId,
          folderId,
        ])
      ).rowCount,
    ).toBe(0);
  });

  it('keeps exact runtime/worker least privilege and every purge mutation lease-fenced', async () => {
    const tables = [
      'room',
      'document',
      'folder',
      'working_structure_entry',
      'published_structure_entry',
      'document_version',
    ] as const;
    for (const role of ['duefold_runtime', 'duefold_worker'] as const) {
      for (const table of tables) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const) {
          const actual = (
            await migrationPool.query<{ v: boolean }>(
              'SELECT has_table_privilege($1,$2,$3) v',
              [role, table, privilege],
            )
          ).rows[0]?.v;
          const expected =
            (role === 'duefold_runtime' && table === 'document' && privilege === 'INSERT') ||
            /*
             * Only the WORKER may read document_version. The row carries the
             * original filename and storage object key, so a web-role table read
             * enumerated every source object with no viewer, grant, or
             * publication check. Credential-free processing genuinely needs the
             * object key; the web role reaches version data only through
             * SECURITY DEFINER functions that authorize first.
             */
            (role === 'duefold_worker' &&
              table === 'document_version' &&
              privilege === 'SELECT');
          expect(actual, `${role} ${privilege} ${table}`).toBe(expected);
        }
      }
    }
    const functions: readonly [string, string][] = [
      ['begin_trash_purge', 'begin_trash_purge(text,text,text,text)'],
      ['finalize_trash_purge', 'finalize_trash_purge(text,text,text,text,text,text)'],
      ['publish_room_structure', 'publish_room_structure(text,text,integer,integer,text,text)'],
    ];
    for (const role of ['duefold_runtime', 'duefold_worker'] as const)
      for (const [name, signature] of functions) {
        const actual = (
          await migrationPool.query<{ v: boolean }>(
            'SELECT has_function_privilege($1,$2,$3) v',
            [role, signature, 'EXECUTE'],
          )
        ).rows[0]?.v;
        expect(actual, `${role} EXECUTE ${name}`).toBe(
          role === 'duefold_worker' && name !== 'publish_room_structure',
        );
      }

    const definition = (
      await migrationPool.query<{ source: string }>(
        `SELECT pg_get_functiondef('finalize_trash_purge(text,text,text,text,text,text)'::regprocedure) source`,
      )
    ).rows[0]?.source;
    if (definition === undefined) throw new Error('PURGE_DEFINITION_ABSENT');
    const mutationStart = definition.indexOf('DELETE FROM verified_derivative_object');
    const mutationEnd = definition.indexOf('-- Retained audit');
    expect(mutationStart).toBeGreaterThan(0);
    expect(mutationEnd).toBeGreaterThan(mutationStart);
    const mutatingStatements = definition
      .slice(mutationStart, mutationEnd)
      .split(';')
      .filter((statement) => /(?:DELETE FROM|UPDATE)/u.test(statement));
    expect(mutatingStatements).toHaveLength(12);
    for (const statement of mutatingStatements)
      expect(statement).toMatch(
        /lease_owner\s*=\s*p_lease_owner[\s\S]*lease_token\s*=\s*p_lease_token[\s\S]*lease_expires_at\s*>\s*transaction_timestamp\(\)/u,
      );
  });
});
