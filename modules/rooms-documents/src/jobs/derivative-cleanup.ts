import type { Pool } from 'pg';
import type { JobContext, LeasedJob } from '../../../../apps/worker/src/runner.ts';
import type { WorkerStorage } from '../storage/s3-compatible.ts';

export interface DerivativeCleanupDependencies {
  readonly pool: Pool;
  readonly storage: WorkerStorage;
}
function objectKey(payload: Readonly<Record<string, unknown>>): string {
  const value = payload['objectKey'];
  if (
    typeof value !== 'string' ||
    !/^derivatives\/[A-Za-z0-9_-]{32}\/[A-Za-z0-9_-]{32}$/u.test(value)
  )
    throw new Error('INVALID_JOB_PAYLOAD');
  return value;
}
export function createHandler(dependencies: DerivativeCleanupDependencies) {
  return async (job: LeasedJob, context: JobContext): Promise<void> => {
    const key = objectKey(job.payload);
    /*
     * Validate the lease and the recorded cleanup intent BEFORE deleting bytes.
     * Deleting first made storage deletion reachable from any leased job naming
     * an object key, so forged cleanup work destroyed live derivatives. Storage
     * deletion is idempotent, so a retry after a later failure is safe.
     */
    await dependencies.pool.query('SELECT resolve_derivative_cleanup($1,$2,$3,$4)', [
      key,
      job.id,
      context.leaseOwner,
      job.lease_token,
    ]);
    await dependencies.storage.deleteObject(key);
  };
}
