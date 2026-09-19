import type { Pool } from 'pg';
import { createOpaqueId } from '@duefold/shared/ids';
import type { JobContext, LeasedJob } from '../../../../apps/worker/src/runner.ts';
export interface PreviewInactivityDependencies {
  readonly pool: Pool;
}
function activityId(payload: Readonly<Record<string, unknown>>): string {
  const value = payload['activityId'];
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{32}$/u.test(value))
    throw new Error('INVALID_JOB_PAYLOAD');
  return value;
}
export function createHandler(dependencies: PreviewInactivityDependencies) {
  return async (job: LeasedJob, context: JobContext): Promise<void> => {
    await dependencies.pool.query('SELECT finalize_or_reschedule_preview($1,$2,$3,$4,$5)', [
      activityId(job.payload),
      job.id,
      context.leaseOwner,
      job.lease_token,
      createOpaqueId(),
    ]);
  };
}
