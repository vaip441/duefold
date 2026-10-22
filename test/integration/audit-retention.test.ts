import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import { generatedJobs } from '../../.duefold/generated/jobs.ts';
import { createHandler } from '../../modules/rooms-documents/src/jobs/audit-retention.ts';
import { JobRunner } from '../../apps/worker/src/runner.ts';
import {
  authPool,
  closePools,
  databasePool,
  migrationPool,
  resetSchema,
  workerPool,
} from '../authz/support/database.ts';

const oneYearRoomId = createOpaqueId();

beforeAll(async () => {
  await resetSchema();
  await migrationPool.query(
    `INSERT INTO room(id,title,state,description,audit_retention_years)
     VALUES($1,'One-year retention','draft','',1)`,
    [oneYearRoomId],
  );
});
afterAll(closePools);

/** retain_until is derived at insert from occurred_at and the room's policy (seven years without a room). */
async function insertAudit(occurredAgo: string, roomId: string | null): Promise<string> {
  const id = createOpaqueId();
  await migrationPool.query(
    `INSERT INTO audit_event(id,event_type,actor_kind,room_id,result,reason_code,correlation_id,occurred_at)
     VALUES($1,'room.state','system',$2,'success','FIXTURE',$3,statement_timestamp()-$4::interval)`,
    [id, roomId, createCorrelationId(), occurredAgo],
  );
  return id;
}

async function expiredCount(): Promise<number> {
  return Number(
    (
      await migrationPool.query<{ count: string }>(
        'SELECT count(*) FROM audit_event WHERE retain_until<statement_timestamp()',
      )
    ).rows[0]?.count,
  );
}

async function present(ids: readonly string[]): Promise<string[]> {
  return (
    await migrationPool.query<{ id: string }>('SELECT id FROM audit_event WHERE id=ANY($1)', [
      ids,
    ])
  ).rows
    .map(({ id }) => id)
    .sort();
}

async function insertRunningJob(): Promise<{ id: string; owner: string; token: string }> {
  const job = { id: createOpaqueId(), owner: createOpaqueId(), token: createOpaqueId() };
  await migrationPool.query(
    `INSERT INTO job_queue(id,job_type,idempotency_key,payload,state,attempts,lease_owner,lease_token,
       lease_expires_at)
     VALUES($1,'audit.retention.sweep',$1,'{}'::jsonb,'running',1,$2,$3,
       statement_timestamp()+interval '5 minutes')`,
    [job.id, job.owner, job.token],
  );
  return job;
}

const deleteRow = 'DELETE FROM audit_event WHERE id=$1';

/** A mutation in a transaction that raised the sweep's flag itself. */
async function mutateWithFlag(pool: Pool, statement: string, id: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('duefold.audit_retention_sweep','on',true)");
    await client.query(statement, [id]);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

const purge = (pool: Pool, job: { id: string; owner: string; token: string }) =>
  pool.query<{ deleted: number }>(
    'SELECT purge_expired_audit_events($1,$2,$3,$4,$5) AS deleted',
    [job.id, job.owner, job.token, createOpaqueId(), createCorrelationId()],
  );

describe('audit retention sweep', () => {
  it('is declared as the daily worker job the migration seeds', () => {
    const declared = generatedJobs.find(({ id }) => id === 'audit.retention.sweep');
    expect(declared).toMatchObject({ module: 'rooms-documents', everySeconds: 86400 });
    expect(typeof declared?.handlerFactory).toBe('function');
  });

  it('deletes rows past retention in bounded batches and keeps the rest', async () => {
    const expiredByRoomPolicy = await insertAudit('2 years', oneYearRoomId);
    const keptByDefaultPolicy = await insertAudit('2 years', null);
    const keptRecent = await insertAudit('6 months', oneYearRoomId);
    await migrationPool.query(
      `INSERT INTO audit_event(id,event_type,actor_kind,result,reason_code,correlation_id,occurred_at)
       SELECT replace(gen_random_uuid()::text,'-',''),'room.state','system','success','FIXTURE',
         'corr_'||replace(gen_random_uuid()::text,'-',''),statement_timestamp()-interval '8 years'
       FROM generate_series(1,1000)`,
    );
    expect(await expiredCount()).toBe(1001);

    const batch = await purge(workerPool, await insertRunningJob());
    expect(batch.rows[0]?.deleted).toBe(1000);
    expect(await expiredCount()).toBe(1);

    await migrationPool.query(
      "UPDATE job_queue SET available_at='infinity' WHERE state='pending'",
    );
    await migrationPool.query(
      `UPDATE job_queue SET available_at=statement_timestamp()-interval '1 minute'
       WHERE job_type='audit.retention.sweep' AND idempotency_key='audit-retention:initial'`,
    );
    const runner = new JobRunner(
      workerPool,
      new Map([['audit.retention.sweep', createHandler({ pool: workerPool })]]),
    );
    expect(await runner.runOne()).toBe(true);

    expect(await expiredCount()).toBe(0);
    expect(await present([expiredByRoomPolicy, keptByDefaultPolicy, keptRecent])).toStrictEqual(
      [keptByDefaultPolicy, keptRecent].sort(),
    );
    const seeded = await migrationPool.query<{ id: string; state: string }>(
      "SELECT id,state FROM job_queue WHERE idempotency_key='audit-retention:initial'",
    );
    expect(seeded.rows.map(({ state }) => state)).toStrictEqual(['succeeded']);
    const successors = await migrationPool.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM job_queue
       WHERE job_type='audit.retention.sweep' AND state='pending'`,
    );
    expect(successors.rows).toStrictEqual([
      { idempotency_key: `audit-retention-sweep:${seeded.rows[0]?.id}` },
    ]);
    const sweeps = await migrationPool.query<{ actor_kind: string; deleted: number }>(
      `SELECT actor_kind,(detail->>'deletedCount')::int AS deleted FROM audit_event
       WHERE reason_code='EXPIRED_AUDIT_DELETED' ORDER BY sequence`,
    );
    expect(sweeps.rows).toStrictEqual([
      { actor_kind: 'system', deleted: 1000 },
      { actor_kind: 'system', deleted: 1 },
    ]);
  });

  it('keeps audit append-only on every other path', async () => {
    const expired = await insertAudit('8 years', null);
    const live = await insertAudit('1 day', null);
    for (const pool of [databasePool, authPool, workerPool]) {
      await expect(pool.query(deleteRow, [expired])).rejects.toMatchObject({ code: '42501' });
      await expect(mutateWithFlag(pool, deleteRow, expired)).rejects.toMatchObject({
        code: '42501',
      });
    }
    await expect(migrationPool.query(deleteRow, [expired])).rejects.toMatchObject({
      code: '55000',
    });
    await expect(mutateWithFlag(migrationPool, deleteRow, live)).rejects.toMatchObject({
      code: '55000',
    });
    await expect(
      mutateWithFlag(
        migrationPool,
        "UPDATE audit_event SET reason_code='TAMPERED' WHERE id=$1",
        expired,
      ),
    ).rejects.toMatchObject({ code: '55000' });
    expect(await present([expired, live])).toStrictEqual([expired, live].sort());
    const reasons = await migrationPool.query<{ reason_code: string }>(
      'SELECT DISTINCT reason_code FROM audit_event WHERE id=ANY($1)',
      [[expired, live]],
    );
    expect(reasons.rows).toStrictEqual([{ reason_code: 'FIXTURE' }]);

    const job = await insertRunningJob();
    await expect(purge(workerPool, { ...job, token: createOpaqueId() })).rejects.toMatchObject({
      code: '55000',
    });
    for (const pool of [databasePool, authPool])
      await expect(purge(pool, job)).rejects.toMatchObject({ code: '42501' });
  });
});
