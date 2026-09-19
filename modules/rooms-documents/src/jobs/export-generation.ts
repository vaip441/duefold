import type { Pool } from 'pg';
import type { JobContext, LeasedJob } from '../../../../apps/worker/src/runner.ts';
import type { WorkerStorage } from '../storage/s3-compatible.ts';
import { generateExportJob, type ExportStorage } from '../exports.ts';

export interface ExportGenerationDependencies {
  readonly pool: Pool;
  readonly storage: WorkerStorage;
}
function exportId(payload: Readonly<Record<string, unknown>>): string {
  const value = payload['exportId'];
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{32}$/u.test(value))
    throw new Error('INVALID_JOB_PAYLOAD');
  return value;
}
function adapter(storage: WorkerStorage): ExportStorage {
  return {
    streamSource: (key) => storage.streamObject(key),
    putStream: (input) => storage.putExportStream(input),
    streamExport: (key) => storage.streamObject(key),
    delete: (key) => storage.deleteObject(key),
  };
}
export function createHandler(dependencies: ExportGenerationDependencies) {
  return async (job: LeasedJob, context: JobContext): Promise<void> => {
    await context.assertLease();
    await generateExportJob({
      pool: dependencies.pool,
      storage: adapter(dependencies.storage),
      exportId: exportId(job.payload),
      jobId: job.id,
      leaseOwner: context.leaseOwner,
      leaseToken: job.lease_token,
    });
  };
}
