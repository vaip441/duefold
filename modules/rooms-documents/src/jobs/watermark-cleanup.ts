import type { Pool } from 'pg';
import type { JobContext, LeasedJob } from '../../../../apps/worker/src/runner.ts';
import type { WorkerStorage } from '../storage/s3-compatible.ts';
export interface WatermarkCleanupDependencies {
  readonly pool: Pool;
  readonly storage: WorkerStorage;
}
function cacheId(payload: Readonly<Record<string, unknown>>): string {
  const value = payload['cacheId'];
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{32}$/u.test(value))
    throw new Error('INVALID_JOB_PAYLOAD');
  return value;
}
export function createHandler(dependencies: WatermarkCleanupDependencies) {
  return async (job: LeasedJob, context: JobContext): Promise<void> => {
    const id = cacheId(job.payload);
    const selected = (
      await dependencies.pool.query<{ object_key: string }>(
        'SELECT object_key FROM begin_watermark_deletion($1,$2,$3,$4)',
        [id, job.id, context.leaseOwner, job.lease_token],
      )
    ).rows[0];
    if (selected === undefined) throw new Error('WATERMARK_CLEANUP_NOT_AUTHORIZED');
    await context.assertLease();
    try {
      await dependencies.storage.deleteObject(selected.object_key);
    } catch (error) {
      // S3-compatible DELETE is idempotent for an absent key; doubles may model
      // the crash-before-upload window explicitly with this stable code.
      if (!(error instanceof Error && error.message === 'STORAGE_OBJECT_ABSENT')) throw error;
    }
    await dependencies.pool.query('SELECT finish_watermark_deletion($1,$2,$3,$4)', [
      id,
      job.id,
      context.leaseOwner,
      job.lease_token,
    ]);
  };
}
