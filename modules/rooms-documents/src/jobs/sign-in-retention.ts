import type { Pool } from 'pg';
import type { JobContext, LeasedJob } from '../../../../apps/worker/src/runner.ts';

export interface SignInRetentionDependencies {
  readonly pool: Pool;
}
/** Daily sweep of ended sign-in codes and sessions; the runner queues each next run. */
export function createHandler(dependencies: SignInRetentionDependencies) {
  return async (job: LeasedJob, context: JobContext): Promise<void> => {
    await dependencies.pool.query('SELECT purge_ended_sign_in($1,$2,$3)', [
      job.id,
      context.leaseOwner,
      job.lease_token,
    ]);
  };
}
