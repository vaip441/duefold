import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import { generatedMigrations } from '../../.duefold/generated/migrations.ts';
import { generatedJobs } from '../../.duefold/generated/jobs.ts';
import { migrate } from '../../modules/core-security/src/db/migrate.ts';
import { createHandler } from '../../modules/rooms-documents/src/jobs/sign-in-retention.ts';
import { JobRunner } from '../../apps/worker/src/runner.ts';

const bootstrapPool = new Pool({ host: '/var/run/postgresql', database: 'duefold_test' });
const migrationPool = new Pool({
  connectionString: process.env['DUEFOLD_TEST_MIGRATION_DATABASE_URL'],
});
const runtimePool = new Pool({ connectionString: process.env['DUEFOLD_TEST_DATABASE_URL'] });
const authPool = new Pool({ connectionString: process.env['DUEFOLD_TEST_AUTH_DATABASE_URL'] });
const workerPool = new Pool({
  connectionString: process.env['DUEFOLD_TEST_WORKER_DATABASE_URL'],
});

const memberId = createOpaqueId();
const viewerId = createOpaqueId();
const roomId = createOpaqueId();
const documentId = createOpaqueId();
const versionId = createOpaqueId();
const derivativeId = createOpaqueId();

/** A session that ended `endedDaysAgo` days ago, or a live one when null. */
async function insertSession(
  principal: 'member' | 'viewer',
  endedDaysAgo: number | null,
  state: 'active' | 'revoked' | 'expired' = 'expired',
): Promise<string> {
  const id = createOpaqueId();
  await migrationPool.query(
    `INSERT INTO session(id,secret_digest,csrf_digest,principal_kind,member_id,viewer_id,family_id,
       state,idle_expires_at,absolute_expires_at,last_seen_at,created_at)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,ended,ended+interval '1 hour',ended-interval '1 hour',
       ended-interval '2 hours'
     FROM (SELECT CASE WHEN $9::integer IS NULL THEN statement_timestamp()+interval '1 hour'
       ELSE statement_timestamp()-make_interval(days=>$9::integer) END AS ended) t`,
    [
      id,
      createOpaqueId().padEnd(64, 'd'),
      createOpaqueId().padEnd(64, 'c'),
      principal,
      principal === 'member' ? memberId : null,
      principal === 'viewer' ? viewerId : null,
      createOpaqueId(),
      endedDaysAgo === null ? 'active' : state,
      endedDaysAgo,
    ],
  );
  return id;
}

async function insertOtp(state: 'pending' | 'consumed' | 'expired', endedDaysAgo: number) {
  const id = createOpaqueId();
  await migrationPool.query(
    `INSERT INTO otp_challenge(id,email_key,viewer_id,digest,state,network_period,network_hmac,
       browser_category,os_category,device_category,expires_at,created_at)
     SELECT $1,'retention-viewer@example.com',$2,$3,$4,'2026-10',$5,'chromium','linux','desktop',
       ended,ended-interval '10 minutes'
     FROM (SELECT statement_timestamp()-make_interval(days=>$6::integer) AS ended) t`,
    [id, viewerId, 'b'.repeat(64), state, 'a'.repeat(64), endedDaysAgo],
  );
  return id;
}

/** A code invalidated before delivery: it never had a digest or expiry, so creation dates it. */
async function insertUndeliveredOtp(createdDaysAgo: number) {
  const id = createOpaqueId();
  await migrationPool.query(
    `INSERT INTO otp_challenge(id,email_key,viewer_id,state,network_period,network_hmac,
       browser_category,os_category,device_category,created_at)
     VALUES($1,'retention-viewer@example.com',$2,'invalidated','2026-10',$3,'chromium','linux',
       'desktop',statement_timestamp()-make_interval(days=>$4::integer))`,
    [id, viewerId, 'a'.repeat(64), createdDaysAgo],
  );
  return id;
}

async function insertPreview(sessionId: string, state: 'active' | 'inactive') {
  await migrationPool.query(
    `INSERT INTO preview_activity(id,viewer_id,session_id,room_id,document_id,version_id,correlation_id,
       network_period,network_hmac,browser_category,os_category,device_category,state,summarized_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,'2026-10',$8,'chromium','linux','desktop',$9,
       CASE WHEN $9='active' THEN NULL ELSE statement_timestamp() END)`,
    [
      createOpaqueId(),
      viewerId,
      sessionId,
      roomId,
      documentId,
      versionId,
      createCorrelationId(),
      'a'.repeat(64),
      state,
    ],
  );
}

async function insertWatermark(sessionId: string, state: 'deletion_pending' | 'deleted') {
  await migrationPool.query(
    `INSERT INTO watermark_cache(id,viewer_id,session_id,room_id,document_id,version_id,derivative_id,
       page_number,object_key,media_type,state,access_date,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,'image/png',$9,current_date,
       statement_timestamp()+interval '1 hour')`,
    [
      createOpaqueId(),
      viewerId,
      sessionId,
      roomId,
      documentId,
      versionId,
      derivativeId,
      `watermarks/${createOpaqueId()}/${createOpaqueId()}`,
      state,
    ],
  );
}

async function insertRunningJob(
  jobType: string,
  leaseMinutes: number,
): Promise<{ id: string; owner: string; token: string }> {
  const job = { id: createOpaqueId(), owner: createOpaqueId(), token: createOpaqueId() };
  await migrationPool.query(
    `INSERT INTO job_queue(id,job_type,idempotency_key,payload,state,attempts,lease_owner,lease_token,
       lease_expires_at)
     VALUES($1,$2,$1,'{}'::jsonb,'running',1,$3,$4,statement_timestamp()+make_interval(mins=>$5::integer))`,
    [job.id, jobType, job.owner, job.token, leaseMinutes],
  );
  return job;
}

async function remaining(table: 'session' | 'otp_challenge', ids: readonly string[]) {
  return (
    await migrationPool.query<{ id: string }>(`SELECT id FROM ${table} WHERE id=ANY($1)`, [ids])
  ).rows
    .map(({ id }) => id)
    .sort();
}

async function auditCount(): Promise<number> {
  return Number(
    (await migrationPool.query<{ count: string }>('SELECT count(*) FROM audit_event')).rows[0]
      ?.count,
  );
}

beforeAll(async () => {
  await bootstrapPool.query(
    'DROP SCHEMA public CASCADE; CREATE SCHEMA public; ALTER SCHEMA public OWNER TO duefold_migration;',
  );
  await migrate(migrationPool, generatedMigrations);
  const client = await migrationPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO member(id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state) VALUES($1,'retention-owner@example.com','retention-owner@example.com','https://issuer.example',$1,'owner','active')",
      [memberId],
    );
    await client.query("INSERT INTO organization(id,name) VALUES($1,'Test Organization')", [
      createOpaqueId(),
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await migrationPool.query('SELECT create_room($1,$2,$3,$4,$5,$6)', [
    roomId,
    'Retention Room',
    'Sign-in retention fixtures',
    memberId,
    createOpaqueId(),
    createCorrelationId(),
  ]);
  await migrationPool.query(
    "INSERT INTO document(id,room_id,display_title,created_by) VALUES($1,$2,'Retention target',$3)",
    [documentId, roomId, memberId],
  );
  await migrationPool.query(
    `INSERT INTO document_version(id,document_id,original_filename,object_key,declared_media_type,size_bytes,state)
     VALUES($1,$2,'target.pdf',$3,'application/pdf',10,'quarantine')`,
    [versionId, documentId, `quarantine/${createOpaqueId()}/${createOpaqueId()}`],
  );
  await migrationPool.query(
    `INSERT INTO document_derivative(id,version_id,page_number,object_key,media_type,size_bytes,sha256,width,height,accessible_label)
     VALUES($1,$2,1,$3,'image/png',10,$4,1,1,'Page 1')`,
    [
      derivativeId,
      versionId,
      `derivatives/${createOpaqueId()}/${createOpaqueId()}`,
      'c'.repeat(64),
    ],
  );
  await migrationPool.query(
    "INSERT INTO viewer(id,email_key,email_display,state,session_family_id) VALUES($1,'retention-viewer@example.com','retention-viewer@example.com','active',$2)",
    [viewerId, createOpaqueId()],
  );
});

afterAll(async () => {
  await Promise.all([workerPool.end(), authPool.end(), runtimePool.end()]);
  await migrationPool.end();
  await bootstrapPool.end();
});

describe('sign-in retention sweep', () => {
  it('is declared and seeded a day out', async () => {
    expect(generatedJobs.find(({ id }) => id === 'sign_in.retention.sweep')).toMatchObject({
      module: 'rooms-documents',
    });
    const seeded = (
      await migrationPool.query<{ idempotency_key: string; due_in_hours: number }>(
        `SELECT idempotency_key,extract(epoch FROM available_at-statement_timestamp())/3600 AS due_in_hours
         FROM job_queue WHERE job_type='sign_in.retention.sweep' AND state='pending'`,
      )
    ).rows;
    expect(seeded).toHaveLength(1);
    expect(seeded[0]?.idempotency_key).toBe('sign-in-retention:initial');
    expect(Number(seeded[0]?.due_in_hours)).toBeGreaterThan(23);
  });

  it('indexes every table a session delete probes and cascades into', async () => {
    const indexed = (
      await migrationPool.query<{ table_name: string }>(
        `SELECT DISTINCT i.indrelid::regclass::text AS table_name FROM pg_index i
         JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=i.indkey[0]
         WHERE a.attname='session_id' AND i.indpred IS NULL
           AND i.indrelid::regclass::text IN ('preview_activity','download_lease','watermark_cache')`,
      )
    ).rows.map(({ table_name }) => table_name);
    expect(indexed.sort()).toStrictEqual([
      'download_lease',
      'preview_activity',
      'watermark_cache',
    ]);
  });

  it('deletes codes and sessions 30 days after they end and keeps what is still owed', async () => {
    const otpExpired = await insertOtp('expired', 31);
    const otpConsumed = await insertOtp('consumed', 31);
    const otpRecent = await insertOtp('expired', 29);
    const otpLive = await insertOtp('pending', 0);
    const otpUndeliveredOld = await insertUndeliveredOtp(31);
    const otpUndeliveredRecent = await insertUndeliveredOtp(29);
    const memberOld = await insertSession('member', 31);
    const viewerRevokedOld = await insertSession('viewer', 31, 'revoked');
    const viewerSummarizedOld = await insertSession('viewer', 31);
    await insertPreview(viewerSummarizedOld, 'inactive');
    const recent = await insertSession('member', 29);
    const live = await insertSession('viewer', null);
    const openPreview = await insertSession('viewer', 31);
    await insertPreview(openPreview, 'active');
    const openDownload = await insertSession('viewer', 31);
    await migrationPool.query(
      `INSERT INTO download_lease(id,viewer_id,session_id,room_id,document_id,version_id,correlation_id,
         size_bytes,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,10,statement_timestamp()+interval '10 minutes')`,
      [
        createOpaqueId(),
        viewerId,
        openDownload,
        roomId,
        documentId,
        versionId,
        createCorrelationId(),
      ],
    );
    const pendingWatermark = await insertSession('viewer', 31);
    await insertWatermark(pendingWatermark, 'deletion_pending');
    const deletedWatermark = await insertSession('viewer', 31);
    await insertWatermark(deletedWatermark, 'deleted');
    const auditBefore = await auditCount();

    await migrationPool.query(
      `UPDATE job_queue SET available_at=statement_timestamp()-interval '1 day'
       WHERE job_type='sign_in.retention.sweep' AND state='pending'`,
    );
    const seeded = (
      await migrationPool.query<{ id: string }>(
        "SELECT id FROM job_queue WHERE job_type='sign_in.retention.sweep' AND state='pending'",
      )
    ).rows;
    const runner = new JobRunner(
      workerPool,
      new Map([['sign_in.retention.sweep', createHandler({ pool: workerPool })]]),
    );
    expect(await runner.runOne()).toBe(true);

    expect(
      await remaining('otp_challenge', [
        otpExpired,
        otpConsumed,
        otpRecent,
        otpLive,
        otpUndeliveredOld,
        otpUndeliveredRecent,
      ]),
    ).toStrictEqual([otpRecent, otpLive, otpUndeliveredRecent].sort());
    expect(
      await remaining('session', [
        memberOld,
        viewerRevokedOld,
        viewerSummarizedOld,
        recent,
        live,
        openPreview,
        openDownload,
        pendingWatermark,
        deletedWatermark,
      ]),
    ).toStrictEqual([recent, live, openPreview, openDownload, pendingWatermark].sort());
    expect(await auditCount()).toBe(auditBefore);
    const jobs = (
      await migrationPool.query<{
        state: string;
        idempotency_key: string;
        due_in_hours: number;
      }>(
        `SELECT state,idempotency_key,extract(epoch FROM available_at-statement_timestamp())/3600 AS due_in_hours
         FROM job_queue WHERE job_type='sign_in.retention.sweep' ORDER BY state`,
      )
    ).rows;
    expect(jobs.map(({ state }) => state)).toStrictEqual(['pending', 'succeeded']);
    /* The handler queues nothing: the successor is the runner's, keyed by the run it claimed. */
    expect(seeded).toHaveLength(1);
    expect(jobs[0]?.idempotency_key).toBe(`sign-in-retention-sweep:${seeded[0]?.id ?? ''}`);
    expect(Number(jobs[0]?.due_in_hours)).toBeGreaterThan(23);
  });

  it('refuses without a live lease and to every role but the worker', async () => {
    const leased = await insertRunningJob('sign_in.retention.sweep', 5);
    const expired = await insertRunningJob('sign_in.retention.sweep', -1);
    const otherType = await insertRunningJob('export.cleanup', 5);
    const purge = (id: string, owner: string, token: string) =>
      workerPool.query('SELECT purge_ended_sign_in($1,$2,$3)', [id, owner, token]);
    for (const [id, owner, token] of [
      [createOpaqueId(), leased.owner, leased.token],
      [leased.id, createOpaqueId(), leased.token],
      [leased.id, leased.owner, createOpaqueId()],
      [expired.id, expired.owner, expired.token],
      [otherType.id, otherType.owner, otherType.token],
    ] as const)
      await expect(purge(id, owner, token)).rejects.toMatchObject({ code: '55000' });
    await expect(purge(leased.id, leased.owner, leased.token)).resolves.toBeDefined();
    for (const pool of [runtimePool, authPool])
      await expect(
        pool.query('SELECT purge_ended_sign_in($1,$2,$3)', [
          leased.id,
          leased.owner,
          leased.token,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
  });
});
