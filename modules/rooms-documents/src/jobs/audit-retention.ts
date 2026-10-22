import type { Pool } from 'pg';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import type { JobContext, LeasedJob } from '../../../../apps/worker/src/runner.ts';

export interface AuditRetentionDependencies {
  readonly pool: Pool;
}
/** Daily sweep of audit rows past retention, one bounded batch per transaction until none
 * are due; the runner queues each next run. */
export function createHandler(dependencies: AuditRetentionDependencies) {
  return async (job: LeasedJob, context: JobContext): Promise<void> => {
    for (;;) {
      const batch = await dependencies.pool.query<{ deleted: number }>(
        'SELECT purge_expired_audit_events($1,$2,$3,$4,$5) AS deleted',
        [job.id, context.leaseOwner, job.lease_token, createOpaqueId(), createCorrelationId()],
      );
      if (batch.rows[0]?.deleted === 0) return;
    }
  };
}
