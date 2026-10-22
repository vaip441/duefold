import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { JobRunner } from './runner.ts';

describe('job runner loop', () => {
  it('keeps polling after a failed poll and records only a fixed code', async () => {
    const controller = new AbortController();
    const lines: string[] = [];
    let connects = 0;
    const pool = {
      connect: () => {
        connects += 1;
        if (connects === 2) controller.abort();
        return Promise.reject(
          new Error('connect ECONNREFUSED postgresql://duefold_worker:secret@db:5432'),
        );
      },
    } as unknown as Pool;
    const runner = new JobRunner(pool, new Map(), {
      sink: {
        write: (chunk) => {
          lines.push(chunk);
          return true;
        },
      },
    });
    await expect(
      runner.run({ signal: controller.signal, pollMilliseconds: 1 }),
    ).resolves.toBeUndefined();
    expect(connects).toBe(2);
    const record = `${JSON.stringify({
      event: 'job.run.failed',
      level: 'warn',
      code: 'JOB_RUN_FAILED',
      service: 'worker',
    })}\n`;
    expect(lines).toEqual([record, record]);
  });
});
