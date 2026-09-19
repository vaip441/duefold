import { describe, expect, it, vi } from 'vitest';
import { createHandler } from './export-cleanup.ts';
import type { WorkerStorage } from '../storage/s3-compatible.ts';

describe('export cleanup job', () => {
  it('deletes an expired object before finalizing deletion', async () => {
    const order: string[] = [];
    const pool = {
      query: vi.fn((sql: string) => {
        if (sql === 'SELECT expire_exports($1,$2,$3)') {
          order.push('expire');
          return Promise.resolve({ rows: [] });
        }
        if (sql === 'SELECT * FROM claim_export_cleanup($1,$2,$3)') {
          order.push('claim');
          return Promise.resolve({
            rows: [
              {
                export_id: 'A'.repeat(32),
                object_key: `exports/${'B'.repeat(32)}/${'C'.repeat(32)}`,
              },
            ],
          });
        }
        if (sql === 'SELECT finalize_export_cleanup($1,$2,$3,$4)') {
          order.push('finalize');
          return Promise.resolve({ rows: [{ finalize_export_cleanup: true }] });
        }
        if (sql.startsWith('INSERT INTO job_queue')) {
          order.push('schedule');
          return Promise.resolve({ rows: [], rowCount: 1 });
        }
        return Promise.reject(new Error('unexpected SQL'));
      }),
    };
    const storage = {
      deleteObject: vi.fn(() => {
        order.push('delete');
        return Promise.resolve();
      }),
    } as unknown as WorkerStorage;
    const handler = createHandler({ pool: pool as never, storage });
    await handler(
      {
        id: 'D'.repeat(32),
        job_type: 'export.cleanup',
        payload: {},
        attempts: 1,
        max_attempts: 5,
        lease_token: 'E'.repeat(32),
      },
      {
        leaseOwner: 'F'.repeat(32),
        signal: new AbortController().signal,
        assertLease: () => Promise.resolve(),
      },
    );
    expect(order).toEqual(['expire', 'claim', 'delete', 'finalize', 'schedule']);
  });

  it('does not finalize when physical deletion fails', async () => {
    const pool = {
      query: vi.fn((sql: string) => {
        if (sql === 'SELECT expire_exports($1,$2,$3)') return Promise.resolve({ rows: [] });
        if (sql === 'SELECT * FROM claim_export_cleanup($1,$2,$3)')
          return Promise.resolve({
            rows: [
              {
                export_id: 'A'.repeat(32),
                object_key: `exports/${'B'.repeat(32)}/${'C'.repeat(32)}`,
              },
            ],
          });
        return Promise.reject(new Error('finalize must not run'));
      }),
    };
    const storage = {
      deleteObject: () => Promise.reject(new Error('storage unavailable')),
    } as unknown as WorkerStorage;
    const handler = createHandler({ pool: pool as never, storage });
    await expect(
      handler(
        {
          id: 'D'.repeat(32),
          job_type: 'export.cleanup',
          payload: {},
          attempts: 1,
          max_attempts: 5,
          lease_token: 'E'.repeat(32),
        },
        {
          leaseOwner: 'F'.repeat(32),
          signal: new AbortController().signal,
          assertLease: () => Promise.resolve(),
        },
      ),
    ).rejects.toThrow('storage unavailable');
    expect(pool.query).toHaveBeenCalledTimes(2);
  });
});
