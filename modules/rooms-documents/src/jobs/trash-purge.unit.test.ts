import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { createHandler } from './trash-purge.ts';
import type { WorkerStorage } from '../storage/s3-compatible.ts';

describe('trash purge job', () => {
  it('deletes every manifest key exactly once in lease-checked batches', async () => {
    const manifest = Array.from({ length: 1001 }, (_, index) => `documents/${String(index)}`);
    const events: string[] = [];
    const batches: (readonly string[])[] = [];
    const pool = {
      query: (sql: string) => {
        if (sql === 'SELECT object_key FROM begin_trash_purge($1,$2,$3,$4)')
          return Promise.resolve({ rows: manifest.map((key) => ({ object_key: key })) });
        if (sql === 'SELECT finalize_trash_purge($1,$2,$3,$4,$5,$6)') {
          events.push('finalize');
          return Promise.resolve({ rows: [] });
        }
        return Promise.reject(new Error('unexpected SQL'));
      },
    } as unknown as Pool;
    const storage = {
      deleteObjects: (keys: readonly string[]) => {
        events.push(`delete ${String(keys.length)}`);
        batches.push(keys);
        return Promise.resolve();
      },
    } as unknown as WorkerStorage;
    await createHandler({ pool, storage })(
      {
        id: 'D'.repeat(32),
        job_type: 'room.trash.purge',
        payload: { trashId: 'A'.repeat(32) },
        attempts: 1,
        max_attempts: 5,
        lease_token: 'E'.repeat(32),
      },
      {
        leaseOwner: 'F'.repeat(32),
        signal: new AbortController().signal,
        assertLease: () => {
          events.push('lease');
          return Promise.resolve();
        },
      },
    );
    expect(events).toEqual(['lease', 'delete 1000', 'lease', 'delete 1', 'finalize']);
    expect(batches.flat()).toEqual(manifest);
  });
});
