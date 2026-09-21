/**
 * The scheduled sweep that removes spent ownership-transfer previews.
 *
 * A preview is one-time evidence that the required dry run happened. `transfer_ownership`
 * consumes it, and an unused one lapses, so both are dead rows the moment they are marked
 * — but nothing deleted them. `ownership_transfer_preview` is deliberately free of
 * personal data (the rendered impact is returned to the caller, never stored), so this is
 * not a privacy fix; it is §23's rule that no table grows without bound.
 *
 * Self-rescheduling, matching `export.cleanup`: the next run is queued inside the same
 * lease that performed this one, so a crashed worker does not silently end the schedule
 * and a lost lease cannot queue a duplicate. `DELETE` is idempotent, so a retried job is
 * harmless.
 */

import type { Pool } from 'pg';
import type { JobContext, LeasedJob } from '../../../../apps/worker/src/runner.ts';
import { createOpaqueId } from '@duefold/shared/ids';

export interface OwnershipPreviewPurgeDependencies {
  readonly pool: Pool;
}

export function createHandler(dependencies: OwnershipPreviewPurgeDependencies) {
  return async (job: LeasedJob, context: JobContext): Promise<void> => {
    await dependencies.pool.query('SELECT purge_ownership_transfer_previews()');
    await context.assertLease();
    /*
     * Queued only if this job still holds its lease. Inserting unconditionally would let
     * a worker whose lease had expired queue a second chain, and the queue would then run
     * two sweeps forever.
     */
    const scheduled = await dependencies.pool.query(
      `INSERT INTO job_queue(id,job_type,idempotency_key,payload,available_at,max_attempts)
       SELECT $4,'ownership.preview.purge','ownership-preview-purge:'||$1,'{}'::jsonb,
         statement_timestamp()+interval '1 hour',10
       FROM job_queue j WHERE j.id=$1 AND j.state='running' AND j.lease_owner=$2
         AND j.lease_token=$3 AND j.lease_expires_at>statement_timestamp()`,
      [job.id, context.leaseOwner, job.lease_token, createOpaqueId()],
    );
    if (scheduled.rowCount !== 1) throw new Error('JOB_LEASE_LOST');
  };
}
