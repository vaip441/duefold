/**
 * The scheduled sweep that removes spent ownership-transfer previews.
 *
 * The function existed with a worker-only grant and no caller, so the claim that a
 * consumed preview "is removed rather than retained" was only true in tests. §23 forbids
 * an unbounded table, and a sweep nothing runs is not a bound.
 *
 * Driven through the real `JobRunner` against the real queue rather than by calling the
 * handler directly: what needs proving is that the migration seeds the job, that the
 * runner's registry reaches the handler, and that the handler re-arms the schedule under
 * its own lease. Calling the function would prove only that DELETE works.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { generatedMigrations } from '../../.duefold/generated/migrations.ts';
import { generatedJobs } from '../../.duefold/generated/jobs.ts';
import { createOpaqueId } from '@duefold/shared/ids';
import { migrate } from '../../modules/core-security/src/db/migrate.ts';
import { createHandler } from '../../modules/core-security/src/jobs/ownership-preview-purge.ts';
import { JobRunner } from '../../apps/worker/src/runner.ts';

const bootstrapPool = new Pool({
  host: '/var/run/postgresql',
  database: 'duefold_test',
  max: 4,
});
const migrationPool = new Pool({
  connectionString:
    process.env['DUEFOLD_TEST_MIGRATION_DATABASE_URL'] ??
    'postgresql://duefold_migration:duefold_local_migration@127.0.0.1:5432/duefold_test',
  max: 4,
});
const databasePool = new Pool({
  connectionString:
    process.env['DUEFOLD_TEST_DATABASE_URL'] ??
    'postgresql://duefold_runtime:duefold_local_runtime@127.0.0.1:5432/duefold_test',
  max: 4,
});
const workerPool = new Pool({
  connectionString:
    process.env['DUEFOLD_TEST_WORKER_DATABASE_URL'] ??
    'postgresql://duefold_worker:duefold_local_worker@127.0.0.1:5432/duefold_test',
  max: 4,
});

const ownerId = createOpaqueId();
const successorId = createOpaqueId();

/** The queue row the sweep would claim, made available now instead of in an hour. */
async function releaseSweep(): Promise<void> {
  await migrationPool.query(
    `UPDATE job_queue SET available_at = statement_timestamp() - interval '1 minute'
      WHERE job_type = 'ownership.preview.purge' AND state = 'pending'`,
  );
}

function runner(): JobRunner {
  return new JobRunner(
    workerPool,
    new Map([['ownership.preview.purge', createHandler({ pool: workerPool })]]),
  );
}

/** The purge rows that exist right now, so a case can assert only what IT added. */
async function queuedIds(): Promise<readonly string[]> {
  return (
    await migrationPool.query<{ id: string }>(
      "SELECT id FROM job_queue WHERE job_type='ownership.preview.purge'",
    )
  ).rows.map(({ id }) => id);
}

async function previewCount(): Promise<number> {
  return Number(
    (
      await migrationPool.query<{ count: string }>(
        'SELECT count(*) FROM ownership_transfer_preview',
      )
    ).rows[0]?.count ?? '0',
  );
}

beforeAll(async () => {
  await bootstrapPool.query(
    'DROP SCHEMA public CASCADE; CREATE SCHEMA public; ALTER SCHEMA public OWNER TO duefold_migration;',
  );
  await migrate(migrationPool, generatedMigrations);
  const client = await migrationPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO member
       (id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state)
       VALUES
       ($1,'sweep.owner@example.test','Sweep.Owner@example.test','https://issuer.example','sweep-owner','owner','active'),
       ($2,'sweep.successor@example.test','Sweep.Successor@example.test','https://issuer.example','sweep-successor','admin','active')`,
      [ownerId, successorId],
    );
    await client.query("INSERT INTO organization (id,name) VALUES ($1,'Sweep org')", [
      createOpaqueId(),
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

afterAll(async () => {
  await workerPool.end();
  await databasePool.end();
  await migrationPool.end();
  await bootstrapPool.end();
});

beforeEach(async () => {
  await migrationPool.query('DELETE FROM ownership_transfer_preview');
});

describe('the ownership preview sweep', () => {
  /* The declaration is what binds the seeded job_type to a handler. A migration that
     seeds a type the worker cannot resolve queues a row that fails forever. */
  it('is declared as a worker job under the id the migration seeds', () => {
    const declared = generatedJobs.find(({ id }) => id === 'ownership.preview.purge');
    expect(declared).toMatchObject({ id: 'ownership.preview.purge', module: 'core-security' });
    /* The registry carries the factory, not just the name: a declared id whose handler the
       worker cannot construct queues a row that fails on every attempt. */
    expect(typeof declared?.handlerFactory).toBe('function');
  });

  it('is already queued by the migration, so no deployment step arms it', async () => {
    expect(
      (
        await migrationPool.query<{ state: string; idempotency_key: string }>(
          `SELECT state, idempotency_key FROM job_queue
            WHERE job_type='ownership.preview.purge'`,
        )
      ).rows,
    ).toStrictEqual([{ state: 'pending', idempotency_key: 'ownership-preview-purge:initial' }]);
  });

  it('removes a consumed preview and a lapsed one, and keeps a live one', async () => {
    const previewId = createOpaqueId();
    await databasePool.query('SELECT dry_run_ownership_transfer($1,$2,$3)', [
      previewId,
      successorId,
      ownerId,
    ]);
    /* Three rows in the three states a preview can be in. Consumed and lapsed are both
       spent; the live one is evidence a transfer may still legitimately consume. */
    const consumedId = createOpaqueId();
    const lapsedId = createOpaqueId();
    await migrationPool.query(
      `INSERT INTO ownership_transfer_preview
         (id,actor_id,target_id,target_revision,target_assignment_digest,expires_at,consumed_at)
       SELECT $1,actor_id,target_id,target_revision,target_assignment_digest,
              expires_at,statement_timestamp()
         FROM ownership_transfer_preview WHERE id=$2`,
      [consumedId, previewId],
    );
    await migrationPool.query(
      `INSERT INTO ownership_transfer_preview
         (id,actor_id,target_id,target_revision,target_assignment_digest,created_at,expires_at)
       SELECT $1,actor_id,target_id,target_revision,target_assignment_digest,
              statement_timestamp() - interval '2 hours',
              statement_timestamp() - interval '1 hour'
         FROM ownership_transfer_preview WHERE id=$2`,
      [lapsedId, previewId],
    );
    expect(await previewCount()).toBe(3);

    await releaseSweep();
    expect(await runner().runOne()).toBe(true);

    expect(
      (await migrationPool.query<{ id: string }>('SELECT id FROM ownership_transfer_preview'))
        .rows,
    ).toStrictEqual([{ id: previewId }]);
  });

  /*
   * THE SCHEDULE MUST SURVIVE ITS OWN RUN.
   *
   * The sweep is not driven by an external scheduler: each run queues the next inside the
   * lease that performed it, like `export.cleanup`. If the follow-up were not written, the
   * migration's single seeded row would be consumed on first run and the sweep would never
   * happen again — the table would grow unbounded and nothing would report it.
   */
  it('queues its successor so one run does not end the schedule', async () => {
    /* Scoped to the rows this case produces: earlier cases in this file have already run
       the sweep, so a count over the whole queue would measure the file, not the rule. */
    const before = await queuedIds();
    await releaseSweep();
    expect(await runner().runOne()).toBe(true);
    const rows = (
      await migrationPool.query<{ id: string; state: string; available_at: Date }>(
        `SELECT id, state, available_at FROM job_queue
          WHERE job_type='ownership.preview.purge' AND NOT (id = ANY($1))
          ORDER BY state`,
        [before],
      )
    ).rows;
    /* Exactly one new row, and it is pending: the run that just succeeded was already
       queued before this case began. */
    expect(rows.map(({ state }) => state)).toStrictEqual(['pending']);
    /* Roughly an hour out, not immediately: a sweep that re-queued itself as available
       would spin the worker continuously. */
    const pending = rows.find(({ state }) => state === 'pending');
    expect(pending?.available_at.getTime()).toBeGreaterThan(Date.now() + 30 * 60 * 1000);
  });

  /* The runtime credential must not be able to destroy transfer evidence: deleting a
     preview is how a caller would erase the record that a dry run was required. */
  it('is callable by the worker alone', async () => {
    await expect(
      databasePool.query('SELECT purge_ownership_transfer_previews()'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      workerPool.query('SELECT purge_ownership_transfer_previews()'),
    ).resolves.toBeDefined();
  });
});
