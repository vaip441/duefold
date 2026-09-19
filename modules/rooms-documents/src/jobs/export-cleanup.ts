import type { Pool } from 'pg';
import type { WorkerStorage } from '../storage/s3-compatible.ts';
import type { JobContext, LeasedJob } from '../../../../apps/worker/src/runner.ts';
import { createOpaqueId } from '@duefold/shared/ids';

export interface ExportCleanupDependencies {
  readonly pool: Pool;
  readonly storage: WorkerStorage;
}
/** Scheduled worker sweep. Database state moves to deletion_pending before any
 * object key is returned, so a failed delete cannot make an expired export
 * downloadable again. Storage failure propagates for job retry. */
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
    await context.assertLease();
    const scheduled = await dependencies.pool.query(
      `INSERT INTO job_queue(id,job_type,idempotency_key,payload,available_at,max_attempts)
       SELECT $4,'export.cleanup','export-cleanup:'||$1,'{}'::jsonb,
         statement_timestamp()+interval '5 minutes',10
       FROM job_queue j WHERE j.id=$1 AND j.state='running' AND j.lease_owner=$2
         AND j.lease_token=$3 AND j.lease_expires_at>statement_timestamp()`,
      [job.id, context.leaseOwner, job.lease_token, createOpaqueId()],
    );
    if (scheduled.rowCount !== 1) throw new Error('JOB_LEASE_LOST');
  };
}
