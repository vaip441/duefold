/**
 * The runner queues a recurring job's next run when it claims one, keyed by the claimed
 * job, so however often that job is claimed it queues exactly one successor.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOpaqueId } from '@duefold/shared/ids';
import { JobRunner, type JobHandler } from '../../apps/worker/src/runner.ts';
import {
  closePools,
  migrationPool,
  resetSchema,
  workerPool,
} from '../authz/support/database.ts';

beforeAll(async () => {
  await resetSchema();
  /* Only the job a case queues is due, so the seeded schedules are moved out of the way. */
  await migrationPool.query("UPDATE job_queue SET available_at = 'infinity'");
});
afterAll(closePools);

async function queueCleanup(): Promise<string> {
  const id = createOpaqueId();
  await migrationPool.query(
    `INSERT INTO job_queue(id,job_type,idempotency_key,payload,available_at,max_attempts)
     VALUES($1,'export.cleanup','job-recurrence:'||$1,'{}'::jsonb,'2000-01-01',3)`,
    [id],
  );
  return id;
}

async function job(id: string) {
  return (
    await migrationPool.query<{ state: string; attempts: number }>(
      'SELECT state,attempts FROM job_queue WHERE id=$1',
      [id],
    )
  ).rows[0];
}

async function successors(id: string) {
  return (
    await migrationPool.query<{ state: string; due_in_seconds: number }>(
      `SELECT state,round(extract(epoch FROM available_at-statement_timestamp()))::int AS due_in_seconds
       FROM job_queue WHERE idempotency_key='export-cleanup:'||$1`,
      [id],
    )
  ).rows;
}

const runner = (handler: JobHandler) =>
  new JobRunner(workerPool, new Map([['export.cleanup', handler]]));

describe('a recurring job', () => {
  it('queues one successor across a failed attempt and its retry', async () => {
    const id = await queueCleanup();
    expect(await runner(() => Promise.reject(new Error('fixture failure'))).runOne()).toBe(
      true,
    );
    expect(await job(id)).toStrictEqual({ state: 'pending', attempts: 1 });
    await migrationPool.query("UPDATE job_queue SET available_at='2000-01-01' WHERE id=$1", [
      id,
    ]);

    expect(await runner(() => Promise.resolve()).runOne()).toBe(true);

    expect(await job(id)).toStrictEqual({ state: 'succeeded', attempts: 2 });
    const queued = await successors(id);
    expect(queued.map(({ state }) => state)).toStrictEqual(['pending']);
    expect(queued[0]?.due_in_seconds).toBeGreaterThan(240);
  });

  it('queues one successor when a run loses its lease and is claimed again', async () => {
    const id = await queueCleanup();
    await expect(
      runner(async () => {
        await migrationPool.query(
          "UPDATE job_queue SET lease_expires_at=statement_timestamp()-interval '1 second' WHERE id=$1",
          [id],
        );
        throw new Error('JOB_LEASE_LOST');
      }).runOne(),
    ).rejects.toThrow('JOB_LEASE_LOST');

    expect(await runner(() => Promise.resolve()).runOne()).toBe(true);

    expect(await job(id)).toStrictEqual({ state: 'succeeded', attempts: 2 });
    expect((await successors(id)).map(({ state }) => state)).toStrictEqual(['pending']);
  });
});
