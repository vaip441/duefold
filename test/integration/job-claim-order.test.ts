/**
 * Source validation is the one job a member can queue in bulk, so the runner claims other due
 * work ahead of it rather than in arrival order.
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
  /* Only the jobs this case queues are due, so the seeded schedules are moved out of the way. */
  await migrationPool.query("UPDATE job_queue SET available_at = 'infinity'");
});
afterAll(closePools);

async function queue(jobType: string, availableAt: string): Promise<void> {
  const id = createOpaqueId();
  await migrationPool.query(
    `INSERT INTO job_queue(id,job_type,idempotency_key,payload,available_at)
     VALUES($1,$2,'job-claim-order:'||$1,'{}'::jsonb,$3)`,
    [id, jobType, availableAt],
  );
}

describe('job claiming', () => {
  it('claims a sign-in code delivery before an earlier upload validation backlog', async () => {
    await queue('document.source.validate', '2000-01-01');
    await queue('document.source.validate', '2000-01-02');
    await queue('auth.otp.deliver', '2000-01-03');
    const claimed: string[] = [];
    const record: JobHandler = (job) => {
      claimed.push(job.job_type);
      return Promise.resolve();
    };
    const runner = new JobRunner(
      workerPool,
      new Map([
        ['document.source.validate', record],
        ['auth.otp.deliver', record],
      ]),
    );

    while (await runner.runOne());

    expect(claimed).toStrictEqual([
      'auth.otp.deliver',
      'document.source.validate',
      'document.source.validate',
    ]);
  });
});
