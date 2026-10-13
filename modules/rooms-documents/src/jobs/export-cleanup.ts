import type { Pool } from 'pg';
import type { WorkerStorage } from '../storage/s3-compatible.ts';
import type { JobContext, LeasedJob } from '../../../../apps/worker/src/runner.ts';

export interface ExportCleanupDependencies {
  readonly pool: Pool;
  readonly storage: WorkerStorage;
}
/** Scheduled worker sweep. Database state moves to deletion_pending before any
 * object key is returned, so a failed delete cannot make an expired export
 * downloadable again. Storage failure propagates for job retry. The runner queues the
 * next run when it claims this one, so a slow or retrying run can overlap its
 * successor; deletes are idempotent and the run that loses finalization fails with
 * EXPORT_CLEANUP_CONFLICT and retries. */
export function createHandler(dependencies: ExportCleanupDependencies) {
  return async (job: LeasedJob, context: JobContext): Promise<void> => {
    await dependencies.pool.query('SELECT expire_exports($1,$2,$3)', [
      job.id,
      context.leaseOwner,
      job.lease_token,
    ]);
    const pending = await dependencies.pool.query<{ export_id: string; object_key: string }>(
      'SELECT * FROM claim_export_cleanup($1,$2,$3)',
      [job.id, context.leaseOwner, job.lease_token],
    );
    for (const item of pending.rows) {
      await context.assertLease();
      await dependencies.storage.deleteObject(item.object_key);
      const finalized = await dependencies.pool.query<{ finalize_export_cleanup: boolean }>(
        'SELECT finalize_export_cleanup($1,$2,$3,$4)',
        [item.export_id, job.id, context.leaseOwner, job.lease_token],
      );
      if (finalized.rows[0]?.finalize_export_cleanup !== true)
        throw new Error('EXPORT_CLEANUP_CONFLICT');
    }
  };
}
