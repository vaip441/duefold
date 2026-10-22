import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createHandler } from './source-validation.ts';
import type { JobContext, LeasedJob } from '../../../../apps/worker/src/runner.ts';
import type { ProcessorPrograms } from '../processing/formats.ts';
import type { ClamAvClient } from '../scanning/clamav.ts';
import type { WorkerStorage } from '../storage/s3-compatible.ts';

const job: LeasedJob = {
  id: 'j'.repeat(32),
  job_type: 'document.source.validate',
  payload: { versionId: 'v'.repeat(32) },
  attempts: 1,
  max_attempts: 5,
  lease_token: 't'.repeat(32),
};
const context: JobContext = {
  leaseOwner: 'o'.repeat(32),
  signal: new AbortController().signal,
  assertLease: () => Promise.resolve(),
};

describe('source validation failure', () => {
  it('records the specific deterministic rejection code', async () => {
    const queries: { readonly sql: string; readonly values: readonly unknown[] }[] = [];
    const pool = {
      query: (sql: string, values: readonly unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.startsWith('SELECT object_key'))
          return Promise.resolve({
            rows: [
              {
                object_key: 'quarantine/a/b',
                declared_media_type: 'application/pdf',
                size_bytes: '18',
                state: 'quarantine',
              },
            ],
          });
        return Promise.resolve({ rows: [] });
      },
    } as unknown as Pool;
    const storage = {
      getObjectBytes: () => Promise.resolve(new TextEncoder().encode('plain text, no PDF')),
    } as unknown as WorkerStorage;
    const scanner = {
      scan: () =>
        Promise.resolve({ result: 'clean', signatureVersion: '1', signatureDate: new Date() }),
    } as unknown as ClamAvClient;

    await createHandler({
      pool,
      storage,
      scanner,
      processorPrograms: {} as ProcessorPrograms,
    })(job, context);

    const failure = queries.find(({ sql }) => sql.includes('fail_document_processing'));
    expect(failure?.values.slice(4, 7)).toEqual([
      'rejected',
      'deterministic',
      'SOURCE_TYPE_MISMATCH',
    ]);
  });
});
