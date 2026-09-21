import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { generatedMigrations } from '../../.duefold/generated/migrations.ts';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import { migrate } from '../../modules/core-security/src/db/migrate.ts';
import { createHandler as createMemberInvitationMailHandler } from '../../modules/core-security/src/jobs/member-invitation-mail.ts';
import {
  createRequiredMailer,
  createResendTransport,
  createSmtpTransport,
  type MailTransport,
  type OutboundMail,
} from '../../modules/core-security/src/auth/mail.ts';
import { JobRunner } from '../../apps/worker/src/runner.ts';
import type { JobContext, LeasedJob } from '../../apps/worker/src/runner.ts';
import type { MemberInvitationMailDependencies } from '../../modules/core-security/src/jobs/member-invitation-mail.ts';

const bootstrapPool = new Pool({
  host: '/var/run/postgresql',
  database: 'duefold_test',
  max: 4,
});
const migrationPool = new Pool({
  connectionString:
    process.env['DUEFOLD_TEST_MIGRATION_DATABASE_URL'] ??
    'postgresql://duefold_migration:duefold_local_migration@127.0.0.1:5432/duefold_test',
  max: 4,
});
const databasePool = new Pool({
  connectionString:
    process.env['DUEFOLD_TEST_DATABASE_URL'] ??
    'postgresql://duefold_runtime:duefold_local_runtime@127.0.0.1:5432/duefold_test',
  max: 4,
});
const workerPool = new Pool({
  connectionString:
    process.env['DUEFOLD_TEST_WORKER_DATABASE_URL'] ??
    'postgresql://duefold_worker:duefold_local_worker@127.0.0.1:5432/duefold_test',
  max: 4,
});
const ownerId = createOpaqueId();

beforeAll(async () => {
  await bootstrapPool.query(
    'DROP SCHEMA public CASCADE; CREATE SCHEMA public; ALTER SCHEMA public OWNER TO duefold_migration;',
  );
  await migrate(migrationPool, generatedMigrations);
  const client = await migrationPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO member
       (id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state)
       VALUES ($1,'owner@example.test','Owner@example.test','https://issuer.example','owner','owner','active')`,
      [ownerId],
    );
    await client.query("INSERT INTO organization (id,name) VALUES ($1,'Invitation mail')", [
      createOpaqueId(),
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

/*
 * JobRunner claims the oldest eligible row in the whole queue, so a job left
 * behind by an earlier case would be picked up instead of the one under test.
 * Draining between cases keeps each assertion about its own job.
 */
afterEach(async () => {
  await migrationPool.query("DELETE FROM job_queue WHERE job_type='mail.member_invitation'");
});

afterAll(async () => {
  await workerPool.end();
  await databasePool.end();
  await migrationPool.end();
  await bootstrapPool.end();
});

interface DeliveredOnboarding {
  readonly emailDisplay: string;
  readonly authenticatedLink: string;
  readonly idempotencyKey: string;
}

/** A mailer that records onboarding sends and refuses every other template. */
function recordingMailer(delivered: DeliveredOnboarding[]) {
  return {
    deliver: () => Promise.resolve(),
    deliverInvitation: () => Promise.reject(new Error('WRONG_TEMPLATE')),
    deliverOnboarding: (message: {
      emailDisplay: string;
      authenticatedLink: string;
      idempotencyKey: string;
    }) =>
      Promise.resolve(
        void delivered.push({
          emailDisplay: message.emailDisplay,
          authenticatedLink: message.authenticatedLink,
          idempotencyKey: message.idempotencyKey,
        }),
      ),
    deliverSecurityNotice: () => Promise.resolve(),
    close: () => undefined,
  };
}

async function invite(email: string, jobId: string): Promise<string> {
  const invitationId = createOpaqueId();
  await databasePool.query('SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)', [
    invitationId,
    email.toLowerCase(),
    email,
    'member',
    ownerId,
    jobId,
    createOpaqueId(),
    createCorrelationId(),
  ]);
  return invitationId;
}

it('delivers onboarding mail for a pending member invitation under a valid lease', async () => {
  const jobId = createOpaqueId();
  const invitationId = await invite('Onboard@example.test', jobId);

  const delivered: DeliveredOnboarding[] = [];
  const handler = createMemberInvitationMailHandler({
    pool: workerPool,
    publicUrl: 'https://rooms.example.test/base?secret=redacted#fragment',
    mailer: recordingMailer(delivered),
  });
  const runner = new JobRunner(workerPool, new Map([['mail.member_invitation', handler]]));
  expect(await runner.runOne()).toBe(true);

  expect(delivered).toEqual([
    {
      emailDisplay: 'Onboard@example.test',
      authenticatedLink: 'https://rooms.example.test/',
      idempotencyKey: `member-invitation:${invitationId}`,
    },
  ]);
  expect(
    (
      await migrationPool.query<{ state: string }>('SELECT state FROM job_queue WHERE id=$1', [
        jobId,
      ])
    ).rows[0]?.state,
  ).toBe('succeeded');
});

it('refuses to read the mail projection without the exact live job lease', async () => {
  const jobId = createOpaqueId();
  const invitationId = await invite('Fenced@example.test', jobId);
  const rows = await workerPool.query(
    'SELECT * FROM read_member_invitation_mail($1,$2,$3,$4)',
    [invitationId, jobId, 'not-the-owner', createOpaqueId()],
  );
  expect(rows.rows).toHaveLength(0);
});

/*
 * Revocation and lazy expiry withdraw the queued job, so a withdrawn invitation
 * produces no queue work at all. Before this the job stayed pending, the
 * projection correctly refused the address, and the handler retried to a terminal
 * failed job -- reporting a required-mail failure for mail that must never be sent.
 */
it('withdraws the queued mail job when the invitation is revoked before delivery', async () => {
  const jobId = createOpaqueId();
  const invitationId = await invite('Withdrawn@example.test', jobId);
  await databasePool.query('SELECT revoke_member_invitation($1,$2,$3,$4)', [
    invitationId,
    ownerId,
    createOpaqueId(),
    createCorrelationId(),
  ]);

  expect(
    (
      await migrationPool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM job_queue WHERE id=$1',
        [jobId],
      )
    ).rows[0]?.count,
  ).toBe(0);

  const delivered: DeliveredOnboarding[] = [];
  const runner = new JobRunner(
    workerPool,
    new Map([
      [
        'mail.member_invitation',
        createMemberInvitationMailHandler({
          pool: workerPool,
          publicUrl: 'https://rooms.example.test',
          mailer: recordingMailer(delivered),
        }),
      ],
    ]),
  );
  expect(await runner.runOne()).toBe(false);
  expect(delivered).toEqual([]);
});

it('withdraws the queued mail job when a lapsed invitation is superseded', async () => {
  const lapsedJobId = createOpaqueId();
  const lapsedId = await invite('Superseded@example.test', lapsedJobId);
  await migrationPool.query(
    `UPDATE invitation
        SET created_at = transaction_timestamp() - interval '9 days',
            expires_at = transaction_timestamp() - interval '2 days'
      WHERE id=$1`,
    [lapsedId],
  );
  await invite('Superseded@example.test', createOpaqueId());

  expect(
    (
      await migrationPool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM job_queue WHERE id=$1',
        [lapsedJobId],
      )
    ).rows[0]?.count,
  ).toBe(0);
});

/*
 * A job already leased when the invitation is withdrawn keeps its fencing
 * evidence, so the running worker resolves it rather than having the row deleted
 * underneath it. It must complete as an intentional no-op, not retry to failure.
 */
it('completes without sending when the invitation is revoked mid-lease', async () => {
  const jobId = createOpaqueId();
  const invitationId = await invite('Midlease@example.test', jobId);

  const delivered: DeliveredOnboarding[] = [];
  const runner = new JobRunner(
    workerPool,
    new Map([
      [
        'mail.member_invitation',
        createMemberInvitationMailHandler({
          pool: workerPool,
          publicUrl: 'https://rooms.example.test',
          mailer: recordingMailer(delivered),
        }),
      ],
    ]),
  );
  /* Revoke after the row is leased: the delete only withdraws pending jobs, so
   * this one survives and the handler must reach the terminal-state branch. */
  await migrationPool.query(
    `UPDATE job_queue SET state='running',lease_owner='someone',lease_token=$2,
       lease_expires_at=transaction_timestamp() - interval '1 second' WHERE id=$1`,
    [jobId, createOpaqueId()],
  );
  await databasePool.query('SELECT revoke_member_invitation($1,$2,$3,$4)', [
    invitationId,
    ownerId,
    createOpaqueId(),
    createCorrelationId(),
  ]);

  expect(await runner.runOne()).toBe(true);
  expect(delivered).toEqual([]);
  expect(
    (
      await migrationPool.query<{ state: string; last_error_code: string | null }>(
        'SELECT state,last_error_code FROM job_queue WHERE id=$1',
        [jobId],
      )
    ).rows[0],
  ).toEqual({ state: 'succeeded', last_error_code: null });
});

/*
 * Jobs are at-least-once (§22), so a crash between provider acceptance and the
 * succeeded write lets another worker reclaim and send again. Nothing the handler
 * can do makes that exactly-once: mail leaves through an external side effect
 * whose acceptance cannot be retracted. What the handler guarantees is a
 * request-level idempotency key derived from the invitation alone, identical for
 * every attempt and every worker.
 *
 * The double below models only what Resend documents: a key is retained for 24
 * hours, and a repeated request carrying a key still inside that window returns
 * the original response without sending again. It deliberately does not model
 * permanent suppression, and the second case here drives the same reclaim after
 * the window has lapsed to prove the bound is real rather than assumed away.
 *
 * Two handler attempts are two HTTP requests either way -- counted separately,
 * because they are separate.
 */

/** Retention window Resend documents for an idempotency key. */
const RESEND_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

interface ResendProviderDouble {
  readonly transport: MailTransport;
  /** Idempotency key seen on each request, in order, including replays. */
  readonly requests: (string | undefined)[];
  /** Messages the provider actually accepted for delivery. */
  readonly deliveries: OutboundMail[];
}

/**
 * A Resend stand-in whose only idempotency behaviour is the documented bounded
 * window. `now` is supplied by the caller so a test can advance past the window
 * without waiting, and an entry older than the window is forgotten exactly as a
 * retention bound implies.
 */
function resendDouble(now: () => number): ResendProviderDouble {
  const requests: (string | undefined)[] = [];
  const deliveries: OutboundMail[] = [];
  const retained = new Map<string, { readonly at: number; readonly response: Response }>();
  const transport = createResendTransport({
    apiKey: 'test-key',
    fetch: (_url, init) => {
      const key = new Headers(init?.headers).get('idempotency-key') ?? undefined;
      requests.push(key);
      if (key !== undefined) {
        const entry = retained.get(key);
        /* Retention is a bound, so an entry past the window is forgotten and the
         * next request with the same key is a fresh send. */
        if (entry !== undefined && now() - entry.at >= RESEND_IDEMPOTENCY_WINDOW_MS)
          retained.delete(key);
        const replayed = retained.get(key);
        if (replayed !== undefined) return Promise.resolve(replayed.response.clone());
      }
      if (typeof init?.body !== 'string') throw new Error('test body absent');
      deliveries.push(JSON.parse(init.body) as OutboundMail);
      const response = new Response('{"id":"provider-message"}', { status: 200 });
      if (key !== undefined) retained.set(key, { at: now(), response: response.clone() });
      return Promise.resolve(response);
    },
  });
  return { transport, requests, deliveries };
}

/** Runs one attempt that completes the send and then dies before recording success. */
function crashAfterSend(dependencies: MemberInvitationMailDependencies): JobRunner {
  return new JobRunner(
    workerPool,
    new Map([
      [
        'mail.member_invitation',
        async (job: LeasedJob, context: JobContext) => {
          await createMemberInvitationMailHandler(dependencies)(job, context);
          throw new Error('WORKER_DIED_AFTER_SEND');
        },
      ],
    ]),
  );
}

/** Makes a failed job eligible again so a distinct runner can reclaim it. */
async function makeReclaimable(jobId: string): Promise<void> {
  await migrationPool.query(
    "UPDATE job_queue SET available_at=transaction_timestamp() - interval '1 hour' WHERE id=$1",
    [jobId],
  );
}

it('suppresses a reclaimed re-delivery inside the Resend idempotency window', async () => {
  const jobId = createOpaqueId();
  const invitationId = await invite('Reclaimed@example.test', jobId);

  /* The reclaim happens promptly, which is the realistic case: a worker dies and
   * another picks the job up well inside the provider's retention window. */
  const provider = resendDouble(() => Date.now());
  const dependencies = {
    pool: workerPool,
    publicUrl: 'https://rooms.example.test',
    mailer: createRequiredMailer({
      from: 'mail@example.test',
      transport: provider.transport,
    }),
  };

  /* First attempt: the provider accepts, then the worker dies before it can mark
   * the job succeeded. Crashing after the send is the only ordering that can
   * produce a duplicate at all. */
  expect(await crashAfterSend(dependencies).runOne()).toBe(true);
  expect(provider.requests).toHaveLength(1);

  /* A distinct runner instance holds a distinct lease owner, so this is a genuine
   * reclaim by another worker rather than a retry by the same one. */
  await makeReclaimable(jobId);
  const reclaiming = new JobRunner(
    workerPool,
    new Map([['mail.member_invitation', createMemberInvitationMailHandler(dependencies)]]),
  );
  expect(await reclaiming.runOne()).toBe(true);
  expect(
    (
      await migrationPool.query<{ state: string }>('SELECT state FROM job_queue WHERE id=$1', [
        jobId,
      ])
    ).rows[0]?.state,
  ).toBe('succeeded');

  /* Two attempts reached the provider, each carrying the same key, and within the
   * window the provider mailed the invitee once. This is bounded suppression of
   * this retry, not a guarantee that only one message can ever be delivered. */
  expect(provider.requests).toEqual([
    `member-invitation:${invitationId}`,
    `member-invitation:${invitationId}`,
  ]);
  expect(provider.deliveries).toHaveLength(1);
  expect(provider.deliveries[0]?.to).toBe('Reclaimed@example.test');
});

/*
 * The same reclaim once the retention window has lapsed. The key is unchanged and
 * still sent, but the provider no longer remembers it, so a second message is
 * delivered. Asserting this keeps the test honest about what the key buys:
 * suppression bounded by the provider's documented window, not lifetime
 * single delivery.
 */
it('delivers a second onboarding message when the Resend window has lapsed', async () => {
  const jobId = createOpaqueId();
  const invitationId = await invite('Lapsed@example.test', jobId);

  let clock = Date.now();
  const provider = resendDouble(() => clock);
  const dependencies = {
    pool: workerPool,
    publicUrl: 'https://rooms.example.test',
    mailer: createRequiredMailer({
      from: 'mail@example.test',
      transport: provider.transport,
    }),
  };

  expect(await crashAfterSend(dependencies).runOne()).toBe(true);
  expect(provider.deliveries).toHaveLength(1);

  /* Past the documented retention, so the provider has forgotten the key. */
  clock += RESEND_IDEMPOTENCY_WINDOW_MS + 1_000;
  await makeReclaimable(jobId);
  expect(
    await new JobRunner(
      workerPool,
      new Map([['mail.member_invitation', createMemberInvitationMailHandler(dependencies)]]),
    ).runOne(),
  ).toBe(true);

  expect(provider.requests).toEqual([
    `member-invitation:${invitationId}`,
    `member-invitation:${invitationId}`,
  ]);
  expect(provider.deliveries).toHaveLength(2);
  /* The duplicate is tolerable for exactly the documented reason: the repeat is
   * identical, carrying the same authenticated application link and no role,
   * room, or other protected detail. */
  expect(provider.deliveries[1]).toEqual(provider.deliveries[0]);
  expect(provider.deliveries[1]?.text).toContain('https://rooms.example.test/');
});

/*
 * The same reclaim under SMTP, where no request-level idempotency exists at all:
 * the invitee receives the mail twice however promptly the reclaim happens. That
 * is the honest at-least-once outcome and is asserted rather than hidden, because
 * a custom message header would only claim deduplication that no generic MTA
 * performs.
 *
 * The duplicate is tolerable because the two messages are identical and carry no
 * one-time code or per-attempt state: a second copy of an onboarding notice
 * pointing at the same authenticated link is redundant, not a security event. A
 * viewer OTP could not be treated this way, which is why codes are never
 * delivered by this job.
 */
it('re-delivers onboarding mail under SMTP, identically and without a dedup header', async () => {
  const jobId = createOpaqueId();
  await invite('Smtpreclaim@example.test', jobId);

  const deliveries: OutboundMail[] = [];
  const dependencies = {
    pool: workerPool,
    publicUrl: 'https://rooms.example.test',
    mailer: createRequiredMailer({
      from: 'mail@example.test',
      transport: createSmtpTransport({
        smtpUrl: 'smtp://localhost',
        send: (message) => Promise.resolve(void deliveries.push(message)),
      }),
    }),
  };
  expect(await crashAfterSend(dependencies).runOne()).toBe(true);
  await makeReclaimable(jobId);
  expect(
    await new JobRunner(
      workerPool,
      new Map([['mail.member_invitation', createMemberInvitationMailHandler(dependencies)]]),
    ).runOne(),
  ).toBe(true);

  expect(deliveries).toHaveLength(2);
  expect(deliveries[1]).toEqual(deliveries[0]);
  expect(deliveries[0]?.headers).toEqual({ 'X-Duefold-Brand': 'Duefold' });
  /* The repeat carries the authenticated application link and nothing protected:
   * no role, no room, no inviter. */
  expect(deliveries[1]?.text).toContain('https://rooms.example.test/');
  expect(JSON.stringify(deliveries)).not.toContain('member-invitation:');
});

/*
 * The lease is reasserted immediately before the provider call, so a worker whose
 * lease lapsed between reading the projection and sending stops before any mail
 * leaves. The projection must succeed first, otherwise this would prove only that
 * the fence refuses an unknown worker.
 */
it('does not contact the provider when the lease is lost after the projection read', async () => {
  const jobId = createOpaqueId();
  const invitationId = await invite('Lostlease@example.test', jobId);
  const leaseOwner = createOpaqueId();
  const leaseToken = createOpaqueId();
  await migrationPool.query(
    `UPDATE job_queue SET state='running',lease_owner=$2,lease_token=$3,
       lease_expires_at=transaction_timestamp() + interval '1 hour' WHERE id=$1`,
    [jobId, leaseOwner, leaseToken],
  );
  const leased: LeasedJob = {
    id: jobId,
    job_type: 'mail.member_invitation',
    payload: { invitationId },
    attempts: 1,
    max_attempts: 5,
    lease_token: leaseToken,
  };

  const delivered: DeliveredOnboarding[] = [];
  const handler = createMemberInvitationMailHandler({
    pool: workerPool,
    publicUrl: 'https://rooms.example.test',
    mailer: recordingMailer(delivered),
  });

  /* Proof the projection resolves for this lease, so the failure below can only
   * come from the pre-send reassertion. */
  expect(
    (
      await workerPool.query<{ email_display: string | null }>(
        'SELECT email_display FROM read_member_invitation_mail($1,$2,$3,$4)',
        [invitationId, jobId, leaseOwner, leaseToken],
      )
    ).rows[0]?.email_display,
  ).toBe('Lostlease@example.test');

  await expect(
    handler(leased, {
      leaseOwner,
      signal: new AbortController().signal,
      assertLease: () => Promise.reject(new Error('JOB_LEASE_LOST')),
    }),
  ).rejects.toThrow('JOB_LEASE_LOST');
  expect(delivered).toEqual([]);
});
