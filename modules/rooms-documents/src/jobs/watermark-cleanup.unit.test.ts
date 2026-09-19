import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createHandler } from './watermark-cleanup.ts';
import type { JobContext, LeasedJob } from '../../../../apps/worker/src/runner.ts';
import type { WorkerStorage } from '../storage/s3-compatible.ts';

const job: LeasedJob = {
  id: 'j'.repeat(32),
  job_type: 'document.watermark.delete',
  payload: { cacheId: 'c'.repeat(32) },
  attempts: 1,
  max_attempts: 5,
  lease_token: 't'.repeat(32),
};
const context: JobContext = {
  leaseOwner: 'o'.repeat(32),
  signal: new AbortController().signal,
  assertLease: () => Promise.resolve(),
};

describe('watermark cleanup crash recovery', () => {
  it('finishes an expired creating row when upload never happened', async () => {
    const queries: string[] = [];
    const pool = {
      query: (sql: string) => {
        queries.push(sql);
        if (sql.startsWith('SELECT object_key'))
          return Promise.resolve({ rows: [{ object_key: 'watermarks/a/b' }] });
        return Promise.resolve({ rows: [] });
      },
    } as unknown as Pool;
    const deleteObject = vi.fn(() => Promise.reject(new Error('STORAGE_OBJECT_ABSENT')));
    const storage = { deleteObject } as unknown as WorkerStorage;
    await expect(createHandler({ pool, storage })(job, context)).resolves.toBeUndefined();
    expect(deleteObject).toHaveBeenCalledOnce();
    expect(queries.at(-1)).toContain('finish_watermark_deletion');
  });
});
