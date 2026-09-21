/**
 * The status surface's database side: who may record an observation, what an observation
 * may contain, and who may read the deployment facts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createOpaqueId } from '@duefold/shared/ids';
import {
  authPool,
  closePools,
  databasePool,
  migrationPool,
  workerPool,
} from './support/database.ts';
import { resetRoomSchema, seedMember, seedRoom, staffRoom } from './support/room-fixture.ts';

let ownerId = '';
let adminId = '';
let plainMemberId = '';
let managerId = '';

beforeAll(async () => {
  ownerId = await resetRoomSchema('Installation status');
  adminId = await seedMember('admin', 'status.admin');
  plainMemberId = await seedMember('member', 'status.plain');
  managerId = await seedMember('member', 'status.manager');
  await staffRoom(managerId, await seedRoom(ownerId, 'Status room'), 'manager', ownerId);
});
afterAll(closePools);

const recordWorker = (
  pool: Pool,
  check: string,
  result: string,
  code: string,
  evidenceAt: Date | null = null,
) =>
  pool.query('SELECT record_worker_status_observation($1,$2,$3,$4)', [
    check,
    result,
    code,
    evidenceAt,
  ]);

const recordUpdate = (pool: Pool, result: string, code: string, offered: string | null) =>
  pool.query('SELECT record_update_observation($1,$2,$3)', [result, code, offered]);

async function observation(check: string) {
  return (
    await migrationPool.query<{
      result: string;
      code: string;
      evidence_at: Date | null;
      evidence_version: string | null;
    }>(
      'SELECT result,code,evidence_at,evidence_version FROM deployment_status_observation WHERE check_name=$1',
      [check],
    )
  ).rows[0];
}

describe('recording an observation', () => {
  it('lets the worker record the checks it runs, and overwrites the previous answer', async () => {
    await recordWorker(workerPool, 'storage-privacy', 'fail', 'ANONYMOUS_READ_ALLOWED');
    await recordWorker(workerPool, 'storage-privacy', 'pass', 'ANONYMOUS_ACCESS_REFUSED');
    const built = new Date('2026-09-20T06:24:19.000Z');
    await recordWorker(workerPool, 'scanner', 'pass', 'SIGNATURES_CURRENT', built);
    expect(await observation('storage-privacy')).toStrictEqual({
      result: 'pass',
      code: 'ANONYMOUS_ACCESS_REFUSED',
      evidence_at: null,
      evidence_version: null,
    });
    expect((await observation('scanner'))?.evidence_at).toStrictEqual(built);
    expect(
      (
        await migrationPool.query<{ n: number }>(
          "SELECT count(*)::int n FROM deployment_status_observation WHERE check_name='storage-privacy'",
        )
      ).rows[0]?.n,
    ).toBe(1);
  });

  it('lets the CLI, as the migration role, record the update check', async () => {
    await recordUpdate(migrationPool, 'attention', 'UPDATE_AVAILABLE', '1.4.0');
    expect(await observation('updates')).toStrictEqual({
      result: 'attention',
      code: 'UPDATE_AVAILABLE',
      evidence_at: null,
      evidence_version: '1.4.0',
    });
  });

  it("refuses the worker the CLI's check, and every other credential both writers", async () => {
    await expect(
      recordWorker(workerPool, 'updates', 'pass', 'UPDATE_CURRENT'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      recordUpdate(workerPool, 'pass', 'UPDATE_CURRENT', null),
    ).rejects.toMatchObject({
      code: '42501',
    });
    for (const pool of [databasePool, authPool]) {
      await expect(
        recordWorker(pool, 'storage-privacy', 'pass', 'ANONYMOUS_ACCESS_REFUSED'),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(recordUpdate(pool, 'pass', 'UPDATE_CURRENT', null)).rejects.toMatchObject({
        code: '42501',
      });
    }
  });

  it('stores codes, never prose, so no configuration can be written into status', async () => {
    for (const code of [
      'https://issuer.example/.well-known',
      'bucket duefold-private',
      'owner@example.test',
      'lowercase_code',
      '',
      'A'.repeat(65),
    ])
      await expect(
        recordWorker(workerPool, 'storage-privacy', 'fail', code),
      ).rejects.toMatchObject({ code: '23514' });
  });

  it('binds each evidence column to its one check', async () => {
    /* The writer names the rule the caller broke; the column is the backstop behind it. */
    await expect(
      recordWorker(workerPool, 'storage-versioning', 'pass', 'VERSIONING_ENABLED', new Date()),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      recordUpdate(migrationPool, 'attention', 'UPDATE_AVAILABLE', 'latest'),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('holds no table grant for any application credential', async () => {
    for (const role of ['duefold_runtime', 'duefold_authenticator', 'duefold_worker'])
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
        expect(
          (
            await migrationPool.query<{ held: boolean }>(
              "SELECT has_table_privilege($1,'deployment_status_observation',$2) AS held",
              [role, privilege],
            )
          ).rows[0]?.held,
          `${role} ${privilege}`,
        ).toBe(false);
  });

  /*
   * The containment claim is that configuration CANNOT be stored, not that it happens not to
   * be. Each configured value is offered to the writer as a code and must be refused, so the
   * column's rule is what holds the line rather than the discipline of every caller.
   */
  it('refuses every configured value offered to it as a code', async () => {
    const configured = [
      process.env['DUEFOLD_TEST_DATABASE_URL'],
      process.env['DUEFOLD_STORAGE_BUCKET'],
      process.env['DUEFOLD_STORAGE_ENDPOINT'],
      process.env['DUEFOLD_OIDC_ISSUER'],
      process.env['DUEFOLD_OIDC_CLIENT_ID'],
      process.env['DUEFOLD_AUTH_MAIL_FROM'],
    ].filter((value): value is string => value !== undefined && value !== '');
    expect(configured.length).toBeGreaterThan(0);
    for (const value of configured)
      await expect(
        migrationPool.query(
          "SELECT record_worker_status_observation('scanner','fail',$1,null)",
          [value],
        ),
        value,
      ).rejects.toMatchObject({ code: '23514' });
    expect(
      (
        await migrationPool.query<{ count: string }>(
          "SELECT count(*) AS count FROM deployment_status_observation WHERE result='fail'",
        )
      ).rows[0]?.count,
      'a refused code must leave nothing behind',
    ).toBe('0');
  });
});

describe('reading the deployment status', () => {
  it.each([
    ['Owner', () => ownerId],
    ['Admin', () => adminId],
  ])('answers %s with the migration ledger', async (_label, actor) => {
    const row = (
      await databasePool.query<{ applied_migrations: string[] }>(
        'SELECT * FROM read_deployment_status($1)',
        [actor()],
      )
    ).rows[0];
    const ledger = (
      await migrationPool.query<{ id: string }>('SELECT id FROM duefold_migration ORDER BY id')
    ).rows.map(({ id }) => id);
    expect(row?.applied_migrations).toStrictEqual(ledger);
  });

  it.each([
    ['plain Member', () => plainMemberId],
    ['Room Manager', () => managerId],
  ])('refuses a %s, identically', async (_label, actor) => {
    for (const reader of ['read_deployment_status', 'read_status_observations'])
      await expect(
        databasePool.query(`SELECT * FROM ${reader}($1)`, [actor()]),
      ).rejects.toMatchObject({
        code: '42501',
        message: 'organization administration forbidden',
      });
  });

  it('is not callable by the worker or the authenticator', async () => {
    for (const pool of [workerPool, authPool])
      await expect(
        pool.query('SELECT * FROM read_deployment_status($1)', [ownerId]),
      ).rejects.toMatchObject({ code: '42501' });
  });

  it('counts due work, not work scheduled for later, and looks back seven days for failures', async () => {
    await migrationPool.query('DELETE FROM job_queue');
    const job = (
      type: string,
      state: 'pending' | 'succeeded' | 'failed',
      availableAgo: string,
      updatedAgo = '0 seconds',
    ) =>
      migrationPool.query(
        `INSERT INTO job_queue(id,job_type,idempotency_key,payload,state,available_at,updated_at)
         VALUES($1,$2,$3,'{}'::jsonb,$4,statement_timestamp()-$5::interval,
                statement_timestamp()-$6::interval)`,
        [
          createOpaqueId(),
          type,
          `status-test:${createOpaqueId()}`,
          state,
          availableAgo,
          updatedAgo,
        ],
      );
    await job('document.source.validate', 'pending', '20 minutes');
    await job('document.source.validate', 'pending', '1 minute');
    await job('ownership.preview.purge', 'pending', '-1 hour');
    await job('export.cleanup', 'failed', '2 days', '2 days');
    await job('export.cleanup', 'failed', '10 days', '10 days');
    await job('mail.member_invitation', 'succeeded', '3 hours', '3 hours');
    await job('auth.otp.deliver', 'failed', '1 day', '1 day');

    const row = (
      await databasePool.query<{
        jobs_due: number;
        jobs_running: number;
        jobs_failed_recently: number;
        oldest_due_seconds: number | null;
        mail_delivered_at: Date | null;
        mail_failed_recently: number;
      }>('SELECT * FROM read_deployment_status($1)', [ownerId])
    ).rows[0];
    expect(row).toMatchObject({
      jobs_due: 2,
      jobs_running: 0,
      jobs_failed_recently: 2,
      mail_failed_recently: 1,
    });
    expect(row?.oldest_due_seconds).toBeGreaterThanOrEqual(20 * 60);
    expect(row?.oldest_due_seconds).toBeLessThan(21 * 60);
    expect(row?.mail_delivered_at?.getTime()).toBeLessThan(Date.now() - 2 * 3_600_000);
  });

  it('lists every check in display order, unobserved ones as nulls', async () => {
    await migrationPool.query('DELETE FROM deployment_status_observation');
    await recordWorker(workerPool, 'scanner', 'fail', 'SIGNATURES_STALE', new Date(0));
    const rows = (
      await databasePool.query<{ check_name: string; code: string | null; stale: boolean }>(
        'SELECT check_name,code,stale FROM read_status_observations($1)',
        [adminId],
      )
    ).rows;
    expect(rows).toStrictEqual([
      { check_name: 'storage-privacy', code: null, stale: false },
      { check_name: 'storage-versioning', code: null, stale: false },
      { check_name: 'scanner', code: 'SIGNATURES_STALE', stale: false },
      { check_name: 'updates', code: null, stale: false },
    ]);
  });

  it('marks a worker check stale after three hours and the update check after thirty days', async () => {
    await recordWorker(workerPool, 'storage-versioning', 'pass', 'VERSIONING_ENABLED');
    await recordUpdate(migrationPool, 'pass', 'UPDATE_CURRENT', null);
    const age = (check: string, ago: string) =>
      migrationPool.query(
        'UPDATE deployment_status_observation SET observed_at=statement_timestamp()-$2::interval WHERE check_name=$1',
        [check, ago],
      );
    const stale = async (check: string) =>
      (
        await databasePool.query<{ stale: boolean }>(
          'SELECT stale FROM read_status_observations($1) WHERE check_name=$2',
          [ownerId, check],
        )
      ).rows[0]?.stale;
    await age('storage-versioning', '2 hours 50 minutes');
    await age('updates', '29 days');
    expect([await stale('storage-versioning'), await stale('updates')]).toStrictEqual([
      false,
      false,
    ]);
    await age('storage-versioning', '3 hours 10 minutes');
    await age('updates', '31 days');
    expect([await stale('storage-versioning'), await stale('updates')]).toStrictEqual([
      true,
      true,
    ]);
  });
});

describe('reading the content status', () => {
  it('answers an Owner with the recovery record as the CLI left it', async () => {
    const row = (
      await databasePool.query<Record<string, unknown>>(
        'SELECT * FROM read_content_status($1)',
        [ownerId],
      )
    ).rows[0];
    expect(row).toStrictEqual({
      failed_processing_count: 0,
      backup_status: 'undetermined',
      backup_retention: null,
      recovery_expectation: null,
      acknowledged_at: null,
      restore_drill_status: 'not-tested',
      restore_drill_at: null,
    });
  });

  it('counts versions whose processing failed', async () => {
    const roomId = await seedRoom(ownerId, 'Processing room');
    for (const title of ['First failure', 'Second failure']) {
      const documentId = createOpaqueId();
      await migrationPool.query(
        'INSERT INTO document(id,room_id,display_title,created_by) VALUES($1,$2,$3,$4)',
        [documentId, roomId, title, ownerId],
      );
      await migrationPool.query(
        `INSERT INTO document_version
         (id,document_id,original_filename,object_key,declared_media_type,size_bytes,state,
          failure_kind,failure_code,retained_until)
         VALUES($1,$2,'failed.txt',$3,'text/plain',1,'processing_failed','transient',
                'SCANNER_UNAVAILABLE',statement_timestamp()+interval '7 days')`,
        [createOpaqueId(), documentId, `quarantine/${createOpaqueId()}/${createOpaqueId()}`],
      );
    }
    expect(
      (
        await databasePool.query<{ failed_processing_count: number }>(
          'SELECT failed_processing_count FROM read_content_status($1)',
          [adminId],
        )
      ).rows[0]?.failed_processing_count,
    ).toBe(2);
  });

  it.each([
    ['plain Member', () => plainMemberId],
    ['Room Manager', () => managerId],
  ])('refuses a %s', async (_label, actor) => {
    await expect(
      databasePool.query('SELECT * FROM read_content_status($1)', [actor()]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  /*
   * The failed-document count answers a different question than the recovery record, so an
   * installation without that record still learns its content state instead of a 500.
   */
  it('still answers the processing count where no recovery record exists', async () => {
    await migrationPool.query('BEGIN');
    try {
      await migrationPool.query('DELETE FROM operational_recovery_status');
      const failed = (
        await migrationPool.query<{ count: string }>(
          "SELECT count(*) AS count FROM document_version WHERE state='processing_failed'",
        )
      ).rows[0]?.count;
      const row = (
        await migrationPool.query<{
          failed_processing_count: number;
          backup_status: string | null;
          restore_drill_status: string | null;
        }>('SELECT * FROM read_content_status($1)', [ownerId])
      ).rows[0];
      expect(String(row?.failed_processing_count)).toBe(failed);
      expect(row?.backup_status).toBeNull();
      expect(row?.restore_drill_status).toBeNull();
    } finally {
      await migrationPool.query('ROLLBACK');
    }
  });
});
