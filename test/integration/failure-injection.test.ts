/**
 * §24.1's failure scenarios that nothing else covers: a database that drops the connection
 * under a running transaction, storage that accepts a request and never answers or resets it
 * mid-flight, the same job queued twice, and a queue under capacity pressure.
 *
 * Each case injects a real fault rather than a stubbed rejection — PostgreSQL terminates an
 * actual backend, and the S3 endpoint really does stall or destroy the socket — because the
 * behaviour under test is what the client library and the product do when the thing they
 * depend on stops behaving, and a stub proves only that the stub was called.
 *
 * What must hold in every case: nothing half-applied survives, no fault is mistaken for a
 * success, and a retry after the fault clears reaches the same answer as if it had never
 * happened.
 */
import type { Pool } from 'pg';
import { createResilientPool } from '../../packages/shared/src/database-pool.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCorrelationId, createOpaqueId } from '../../packages/shared/src/ids.ts';
import { JobRunner } from '../../apps/worker/src/runner.ts';
import { createStorageStatusProbe } from '../../modules/rooms-documents/src/storage/status-probe.ts';
import { workerStorageConfig } from '../../modules/rooms-documents/src/storage/s3-compatible.ts';
import { closePools, migrationDatabaseUrl, migrationPool } from '../authz/support/database.ts';
import { resetRoomSchema } from '../authz/support/room-fixture.ts';
import { backendPid } from '../authz/support/administration-fixture.ts';
import { startS3TestEndpoint, type S3TestEndpointOptions } from '../support/s3-endpoint.ts';

const closeables: { close(): Promise<void> }[] = [];

/*
 * Terminations are issued from a pool of this suite's own. Sending them through the shared
 * migrationPool would leave that pool holding connections this suite killed, and every later
 * case in the run would inherit the fault this one injected.
 *
 * Opened on first use rather than at module load: `resetSchema` runs `DROP SCHEMA public
 * CASCADE`, and a connection opened before that holds a session whose search_path resolves
 * to the dropped schema.
 */
let terminator: Pool | undefined;

async function terminate(pid: number): Promise<void> {
  terminator ??= createResilientPool({
    role: 'failure-injection',
    connectionString: migrationDatabaseUrl,
    max: 1,
    sink: { write: () => true },
  });
  await terminator.query('SELECT pg_terminate_backend($1)', [pid]);
}

/** A pool this suite intends to break. It carries the listener for the same reason the product does. */
function injectable(role: 'probe', max = 1) {
  return createResilientPool({
    role,
    connectionString: migrationDatabaseUrl,
    max,
    sink: { write: () => true },
  });
}

let ownerId = '';

/* The capacity case reads the status surface, which only an Owner may, so one is seeded. */
beforeAll(async () => {
  ownerId = await resetRoomSchema('Failure Injection');
});
afterAll(async () => {
  for (const closeable of closeables) await closeable.close();
  await terminator?.end();
  await closePools();
});

async function storageProbe(options: S3TestEndpointOptions) {
  const endpoint = await startS3TestEndpoint(options);
  closeables.push(endpoint);
  return createStorageStatusProbe(
    workerStorageConfig({
      endpoint: endpoint.endpoint,
      region: 'us-east-1',
      bucket: endpoint.bucket,
      credentials: {
        accessKeyId: endpoint.accessKeyId,
        secretAccessKey: endpoint.secretAccessKey,
      },
      pathStyle: true,
      checksumSupport: false,
    }),
  );
}

describe('a database that goes away under a transaction', () => {
  /*
   * A restart during a write is the case where a half-applied change would be worst: the
   * mutation and its audit row are one transaction by invariant 14, so the pair must vanish
   * together. This terminates the backend from a second connection while the first holds an
   * open transaction, which is what a restart looks like to a client mid-statement.
   */
  it('loses the whole transaction, audit row included, and never half of it', async () => {
    const victim = injectable('probe');
    const auditId = createOpaqueId();
    const name = `Injected ${createOpaqueId().slice(0, 8)}`;
    try {
      const client = await victim.connect();
      // pg emits the administrator termination both through the pending query and
      // on the checked-out client. The latter is expected for this injected fault;
      // without a listener Node treats it as an unrelated uncaught exception.
      client.on('error', () => undefined);
      const pid = await backendPid(client);
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO audit_event(id,event_type,actor_kind,resource_type,result,reason_code,correlation_id,detail)
         VALUES($1,'room.create','system','room','success','ROOM_CREATED',$2,jsonb_build_object('probe',$3::text))`,
        [auditId, createCorrelationId(), name],
      );
      /* The row is visible to this transaction before the backend dies. */
      expect(
        (
          await client.query<{ count: string }>(
            'SELECT count(*) AS count FROM audit_event WHERE id=$1',
            [auditId],
          )
        ).rows[0]?.count,
      ).toBe('1');

      await terminate(pid);
      await expect(client.query('SELECT 1')).rejects.toThrow();
      client.release(new Error('connection terminated'));
    } finally {
      await victim.end();
    }

    expect(
      (
        await migrationPool.query<{ count: string }>(
          'SELECT count(*) AS count FROM audit_event WHERE id=$1',
          [auditId],
        )
      ).rows[0]?.count,
      'an uncommitted audit row must not survive the restart',
    ).toBe('0');
  });

  /*
   * After the fault clears, the same work must succeed. A pool that keeps handing out the
   * dead connection would turn one restart into an outage.
   */
  it('serves the next caller from a healthy connection', async () => {
    const pool = injectable('probe', 2);
    try {
      const client = await pool.connect();
      client.on('error', () => undefined);
      const pid = await backendPid(client);
      await terminate(pid);
      await expect(client.query('SELECT 1')).rejects.toThrow();
      client.release(new Error('connection terminated'));

      const answer = await pool.query<{ answer: number }>('SELECT 1 AS answer');
      expect(answer.rows[0]?.answer).toBe(1);
    } finally {
      await pool.end();
    }
  });

  /*
   * A terminated backend must not leave an advisory or row lock held, or the next writer
   * would block forever on a room nobody is editing.
   */
  it('releases the locks the dead transaction held', async () => {
    const victim = injectable('probe');
    try {
      const client = await victim.connect();
      client.on('error', () => undefined);
      const pid = await backendPid(client);
      await client.query('BEGIN');
      await client.query('SELECT * FROM organization FOR UPDATE');
      await terminate(pid);
      client.release(new Error('connection terminated'));

      /* Taking the same lock proves nothing is still holding it. */
      const after = await migrationPool.connect();
      try {
        await after.query('BEGIN');
        await after.query("SET LOCAL lock_timeout='4s'");
        await after.query('SELECT * FROM organization FOR UPDATE');
        await after.query('COMMIT');
      } finally {
        after.release();
      }
    } finally {
      await victim.end();
    }
  });
});

describe('storage that does not answer', () => {
  /*
   * A provider that accepts the connection and then goes silent is worse than one that
   * refuses: without a deadline the worker would wait forever and the hourly observation
   * would stop running. The probe carries its own timeout, so this must come back as the
   * unreachable observation rather than hanging.
   */
  it('gives up on a stalled endpoint and reports it unreachable', async () => {
    const probe = await storageProbe({ fault: () => 'stall' });
    const started = Date.now();
    await expect(probe.privacy()).resolves.toBe('STORAGE_UNREACHABLE');
    /* Proves a deadline was actually enforced rather than the request answering early. */
    expect(Date.now() - started).toBeGreaterThan(500);
  }, 30_000);

  /*
   * A reset mid-request is a different failure from a stall: the socket dies rather than
   * going quiet. It is still an answer about storage, not a fault in the worker.
   */
  it('treats a connection reset as unreachable, not as a refusal', async () => {
    const probe = await storageProbe({ fault: () => 'reset' });
    await expect(probe.privacy()).resolves.toBe('STORAGE_UNREACHABLE');
    await expect(probe.versioning()).resolves.toBe('STORAGE_UNREACHABLE');
  }, 30_000);

  /*
   * Storage privacy is the one check where a wrong answer is dangerous in a specific
   * direction: a fault must never read as "strangers are refused". Only two real refusals
   * may produce that, so a fault on either request has to fall short of it.
   */
  it('never reads a fault as proof that strangers are refused', async () => {
    let requests = 0;
    const probe = await storageProbe({
      fault: () => {
        requests += 1;
        /* The listing request answers normally; the object request dies. */
        return requests === 1 ? 'reset' : undefined;
      },
    });
    const answer = await probe.privacy();
    expect(answer).not.toBe('ANONYMOUS_ACCESS_REFUSED');
    expect(['STORAGE_UNREACHABLE', 'STORAGE_PROBE_INCONCLUSIVE']).toContain(answer);
  }, 30_000);
});

describe('the same job queued twice', () => {
  /*
   * Every recurring job derives its idempotency key from the run that queued it, so a retry
   * after a successful queueing attempts the same key. The queue must refuse the duplicate
   * rather than run the work twice.
   */
  it('refuses the duplicate and keeps exactly one', async () => {
    const key = `failure-injection:${createOpaqueId()}`;
    const queue = async () =>
      migrationPool.query(
        `INSERT INTO job_queue(id,job_type,idempotency_key,payload,available_at,max_attempts)
         VALUES($1,'status.observe',$2,'{}'::jsonb,statement_timestamp(),10)`,
        [createOpaqueId(), key],
      );
    expect((await queue()).rowCount).toBe(1);
    await expect(queue()).rejects.toMatchObject({ code: '23505' });
    expect(
      (
        await migrationPool.query<{ count: string }>(
          'SELECT count(*) AS count FROM job_queue WHERE idempotency_key=$1',
          [key],
        )
      ).rows[0]?.count,
    ).toBe('1');
    await migrationPool.query('DELETE FROM job_queue WHERE idempotency_key=$1', [key]);
  });

  /*
   * Two runners racing for the same pending job must not both get it. The lease is what
   * prevents a document being processed or a mail being sent twice.
   */
  it('leases a job to exactly one of two racing runners', async () => {
    const id = createOpaqueId();
    const key = `failure-injection:${createOpaqueId()}`;
    await migrationPool.query(
      `INSERT INTO job_queue(id,job_type,idempotency_key,payload,available_at,max_attempts)
       VALUES($1,'status.observe',$2,'{}'::jsonb,statement_timestamp(),10)`,
      [id, key],
    );

    const claim = async (owner: string) =>
      (
        await migrationPool.query(
          `UPDATE job_queue SET state='running',attempts=attempts+1,lease_owner=$2,
             lease_token=$3,lease_expires_at=statement_timestamp()+interval '5 minutes',
             updated_at=transaction_timestamp()
           WHERE id=$1 AND state='pending'`,
          [id, owner, createOpaqueId()],
        )
      ).rowCount;

    const [first, second] = await Promise.all([claim('runner-a'), claim('runner-b')]);
    expect(first === 1 || second === 1, 'one runner must win').toBe(true);
    expect(first === 0 || second === 0, 'the other must get nothing').toBe(true);
    expect(
      (
        await migrationPool.query<{ owner: string | null }>(
          'SELECT lease_owner AS owner FROM job_queue WHERE id=$1',
          [id],
        )
      ).rows[0]?.owner,
    ).toMatch(/^runner-[ab]$/u);
    await migrationPool.query('DELETE FROM job_queue WHERE id=$1', [id]);
  });
});

describe('a queue under capacity pressure', () => {
  /*
   * A backlog must be visible rather than silent, because the status surface is where an
   * operator learns that work is not being done. The reader counts only work whose time has
   * come, so a self-rescheduling sweep waiting for its next hour is not a backlog.
   */
  it('reports a backlog of due work and ignores work scheduled for later', async () => {
    const before = (
      await migrationPool.query<{ jobs_due: number }>(
        'SELECT jobs_due FROM read_deployment_status($1)',
        [ownerId],
      )
    ).rows[0]?.jobs_due;

    const due = Array.from({ length: 40 }, () => createOpaqueId());
    for (const id of due)
      await migrationPool.query(
        `INSERT INTO job_queue(id,job_type,idempotency_key,payload,available_at,max_attempts)
         VALUES($1,'status.observe','failure-injection:'||$1,'{}'::jsonb,
                statement_timestamp()-interval '10 minutes',10)`,
        [id],
      );
    const later = createOpaqueId();
    await migrationPool.query(
      `INSERT INTO job_queue(id,job_type,idempotency_key,payload,available_at,max_attempts)
       VALUES($1,'status.observe','failure-injection:'||$1,'{}'::jsonb,
              statement_timestamp()+interval '1 hour',10)`,
      [later],
    );

    const status = (
      await migrationPool.query<{ jobs_due: number; oldest_due_seconds: number | null }>(
        'SELECT jobs_due,oldest_due_seconds FROM read_deployment_status($1)',
        [ownerId],
      )
    ).rows[0];
    expect(status?.jobs_due).toBe((before ?? 0) + 40);
    expect(status?.oldest_due_seconds ?? 0).toBeGreaterThanOrEqual(600);

    await migrationPool.query(
      "DELETE FROM job_queue WHERE idempotency_key LIKE 'failure-injection:%'",
    );
  });

  /*
   * A job that exhausts its attempts must settle as failed and stop being retried, or one
   * poisonous payload would occupy a runner forever.
   */
  it('stops retrying a job that has spent every attempt', async () => {
    const id = createOpaqueId();
    await migrationPool.query(
      `INSERT INTO job_queue(id,job_type,idempotency_key,payload,available_at,max_attempts,attempts,state)
       VALUES($1,'status.observe','failure-injection:'||$1,'{}'::jsonb,
              statement_timestamp()-interval '1 minute',3,3,'failed')`,
      [id],
    );
    const runner = new JobRunner(
      migrationPool,
      new Map([
        [
          'status.observe',
          () => {
            throw new Error('the handler must never be reached for an exhausted job');
          },
        ],
      ]),
    );
    /* Nothing claims it, so the handler above is never called. */
    expect(await runner.runOne(), 'an exhausted job must not be claimed').toBe(false);
    expect(
      (
        await migrationPool.query<{ state: string; attempts: number }>(
          'SELECT state,attempts FROM job_queue WHERE id=$1',
          [id],
        )
      ).rows[0],
    ).toMatchObject({ state: 'failed', attempts: 3 });
    await migrationPool.query('DELETE FROM job_queue WHERE id=$1', [id]);
  });
});

describe('the pools the product actually opens', () => {
  /*
   * `pg` emits `error` on the POOL when a connection dies while idle, which is what a
   * database restart looks like to a running service. Without a listener that emit is an
   * uncaught exception and the process failure handler exits the service, so one restart of
   * PostgreSQL ends every in-flight request instead of costing the one dead connection.
   *
   * This kills an idle connection from a second pool, the way a restart does, and requires
   * the service to still answer afterwards.
   */
  it('survives an idle connection dying and serves the next caller', async () => {
    const lost: string[] = [];
    const pool = createResilientPool({
      role: 'probe',
      connectionString: migrationDatabaseUrl,
      max: 2,
      sink: {
        write(chunk: string) {
          lost.push(chunk);
          return true;
        },
      },
    });
    try {
      /* Warm a connection, then let it go idle in the pool. */
      const pid = (await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
        ?.pid;
      if (pid === undefined) throw new Error('backend pid unavailable');
      await pool.query('SELECT 1');

      await terminate(pid);
      await new Promise((resolve) => setTimeout(resolve, 600));

      expect(
        (await pool.query<{ answer: number }>('SELECT 1 AS answer')).rows[0]?.answer,
        'the pool must recover rather than take the process down',
      ).toBe(1);
    } finally {
      await pool.end();
    }

    /* The loss is reported, as a code, with no connection string in it. */
    expect(lost.length).toBeGreaterThan(0);
    const record = lost.join('');
    expect(record).toContain('database.connection.lost');
    expect(record).toContain('"role":"probe"');
    expect(record).not.toContain('duefold_migration');
    expect(record).not.toContain('password');
    expect(record).not.toContain('127.0.0.1');
  }, 30_000);

  /*
   * A bare `new Pool` reintroduces the crash, and a future edit would do it silently, so the
   * services are required to build their pools through the helper that attaches the listener.
   */
  it('opens no bare pool in a long-running service', async () => {
    const { readFile } = await import('node:fs/promises');
    for (const path of [
      'apps/web/src/main.ts',
      'apps/worker/src/main.ts',
      'modules/core-security/src/db/database.ts',
    ]) {
      const source = await readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
      expect(source, path).not.toMatch(/new Pool\(/u);
      expect(source, path).toContain('createResilientPool');
    }
  });
});
