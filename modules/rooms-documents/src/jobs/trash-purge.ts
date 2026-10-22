import type { Pool } from 'pg';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import type { JobContext, LeasedJob } from '../../../../apps/worker/src/runner.ts';
import { DELETE_OBJECTS_BATCH_KEYS, type WorkerStorage } from '../storage/s3-compatible.ts';

export interface TrashPurgeDependencies {
  readonly pool: Pool;
  readonly storage: WorkerStorage;
}
function trashId(payload: Readonly<Record<string, unknown>>): string {
  const value = payload['trashId'];
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{32}$/u.test(value))
    throw new Error('INVALID_JOB_PAYLOAD');
  return value;
}
export function createHandler(dependencies: TrashPurgeDependencies) {
  return async (job: LeasedJob, context: JobContext): Promise<void> => {
    const id = trashId(job.payload);
    const manifest = await dependencies.pool.query<{ object_key: string }>(
      'SELECT object_key FROM begin_trash_purge($1,$2,$3,$4)',
      [id, job.id, context.leaseOwner, job.lease_token],
    );
    const keys = manifest.rows.map((object) => object.object_key);
    for (let start = 0; start < keys.length; start += DELETE_OBJECTS_BATCH_KEYS) {
      await context.assertLease();
      await dependencies.storage.deleteObjects(
        keys.slice(start, start + DELETE_OBJECTS_BATCH_KEYS),
      );
    }
    await dependencies.pool.query('SELECT finalize_trash_purge($1,$2,$3,$4,$5,$6)', [
      id,
      job.id,
      context.leaseOwner,
      job.lease_token,
      createOpaqueId(),
      createCorrelationId(),
    ]);
  };
}
