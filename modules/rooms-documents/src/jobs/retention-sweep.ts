import type { Pool } from 'pg';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import type { JobContext, LeasedJob } from '../../../../apps/worker/src/runner.ts';
import type { WorkerStorage } from '../storage/s3-compatible.ts';

export interface RetentionSweepDependencies {
  readonly pool: Pool;
  readonly storage: WorkerStorage;
}
function versionId(payload: Readonly<Record<string, unknown>>): string {
  const value = payload['versionId'];
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{32}$/u.test(value))
    throw new Error('INVALID_JOB_PAYLOAD');
  return value;
}
export function createHandler(dependencies: RetentionSweepDependencies) {
  return async (job: LeasedJob, context: JobContext): Promise<void> => {
    const id = versionId(job.payload);
    const pending = await dependencies.pool.query<{ object_key: string }>(
      'SELECT object_key FROM begin_retention_deletion($1,$2,$3,$4,$5,$6)',
      [
        id,
        job.id,
        context.leaseOwner,
        job.lease_token,
        createOpaqueId(),
        createCorrelationId(),
      ],
    );
    const objectKey = pending.rows[0]?.object_key;
    if (objectKey === undefined) {
      await context.assertLease();
      return;
    }
    await dependencies.storage.deleteObject(objectKey);
    await dependencies.pool.query('SELECT finalize_retention_deletion($1,$2,$3,$4,$5,$6)', [
      id,
      job.id,
      context.leaseOwner,
      job.lease_token,
      createOpaqueId(),
      createCorrelationId(),
    ]);
  };
}
