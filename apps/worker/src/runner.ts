import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { generatedJobs } from '../../../.duefold/generated/jobs.ts';
import type { GeneratedJob } from '@duefold/composition/registry-types';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import type { SafeProcessSink } from '@duefold/shared/process-errors';
import { allowlistedTelemetry } from '@duefold/shared/redact';
import type { RequiredMailDeliveryDependencies } from '../../../modules/core-security/src/jobs/required-mail-delivery.ts';
import type { MemberInvitationMailDependencies } from '../../../modules/core-security/src/jobs/member-invitation-mail.ts';
import type { OtpDeliveryDependencies } from '../../../modules/core-security/src/jobs/otp-delivery.ts';
import type { OwnershipPreviewPurgeDependencies } from '../../../modules/core-security/src/jobs/ownership-preview-purge.ts';
import type { SourceValidationDependencies } from '../../../modules/rooms-documents/src/jobs/source-validation.ts';
import type { RetentionSweepDependencies } from '../../../modules/rooms-documents/src/jobs/retention-sweep.ts';
import type { DerivativeCleanupDependencies } from '../../../modules/rooms-documents/src/jobs/derivative-cleanup.ts';
import type { TrashPurgeDependencies } from '../../../modules/rooms-documents/src/jobs/trash-purge.ts';
import type { WatermarkCleanupDependencies } from '../../../modules/rooms-documents/src/jobs/watermark-cleanup.ts';
import type { PreviewInactivityDependencies } from '../../../modules/rooms-documents/src/jobs/preview-inactivity.ts';
import type { DownloadFinalizerDependencies } from '../../../modules/rooms-documents/src/jobs/download-finalizer.ts';
import type { MultipartReapDependencies } from '../../../modules/rooms-documents/src/jobs/multipart-reap.ts';
import type { RoomPurgeDependencies } from '../../../modules/rooms-documents/src/jobs/room-purge.ts';
import type { StatusObserveDependencies } from '../../../modules/rooms-documents/src/jobs/status-observe.ts';
import type { ExportGenerationDependencies } from '../../../modules/rooms-documents/src/jobs/export-generation.ts';
import type { ExportCleanupDependencies } from '../../../modules/rooms-documents/src/jobs/export-cleanup.ts';
import { DatabaseError, escapeIdentifier, type Pool, type PoolClient } from 'pg';

export const JOB_LEASE_SECONDS = 120;
const JOB_HEARTBEAT_SECONDS = 40;
const EXHAUSTION_HOOK_RETRY_SECONDS = 300;
const declaredJobs: readonly GeneratedJob[] = generatedJobs;
const recurrenceSeconds = new Map(
  declaredJobs.flatMap((job) =>
    job.everySeconds === undefined ? [] : [[job.id, job.everySeconds] as const],
  ),
);
const exhaustionHooks = new Map(
  declaredJobs.flatMap((job) =>
    job.onExhausted === undefined ? [] : [[job.id, job.onExhausted] as const],
  ),
);
interface JobRunnerOptions {
  readonly leaseSeconds?: number;
  readonly heartbeatMilliseconds?: number;
  readonly sink?: SafeProcessSink;
}
export interface LeasedJob {
  readonly id: string;
  readonly job_type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly lease_token: string;
}
export interface JobContext {
  readonly leaseOwner: string;
  readonly signal: AbortSignal;
  assertLease(): Promise<void>;
}
export type JobHandler = (job: LeasedJob, context: JobContext) => Promise<void>;
export interface JobHandlerDependencies {
  readonly coreSecurity: OtpDeliveryDependencies &
    RequiredMailDeliveryDependencies &
    MemberInvitationMailDependencies &
    OwnershipPreviewPurgeDependencies;
  readonly roomsDocuments: SourceValidationDependencies &
    MultipartReapDependencies &
    RetentionSweepDependencies &
    DerivativeCleanupDependencies &
    TrashPurgeDependencies &
    WatermarkCleanupDependencies &
    PreviewInactivityDependencies &
    DownloadFinalizerDependencies &
    ExportCleanupDependencies &
    ExportGenerationDependencies &
    RoomPurgeDependencies &
    StatusObserveDependencies;
}
type JobHandlerFactory = (
  dependencies:
    | (OtpDeliveryDependencies &
        RequiredMailDeliveryDependencies &
        MemberInvitationMailDependencies &
        OwnershipPreviewPurgeDependencies)
    | (SourceValidationDependencies &
        MultipartReapDependencies &
        RetentionSweepDependencies &
        DerivativeCleanupDependencies &
        TrashPurgeDependencies &
        WatermarkCleanupDependencies &
        PreviewInactivityDependencies &
        DownloadFinalizerDependencies &
        ExportCleanupDependencies &
        ExportGenerationDependencies &
        RoomPurgeDependencies &
        StatusObserveDependencies),
) => JobHandler;
function isJobHandlerFactory(value: unknown): value is JobHandlerFactory {
  return typeof value === 'function';
}
export class JobRunner {
  readonly #owner = createOpaqueId();
  readonly #handlers = new Map<string, JobHandler>();
  readonly #leaseSeconds: number;
  readonly #heartbeatMilliseconds: number;
  readonly #sink: SafeProcessSink;
  public readonly pool: Pool;
  public constructor(
    pool: Pool,
    handlersOrDependencies?: ReadonlyMap<string, JobHandler> | JobHandlerDependencies,
    options: JobRunnerOptions = {},
  ) {
    this.pool = pool;
    this.#leaseSeconds = options.leaseSeconds ?? JOB_LEASE_SECONDS;
    this.#heartbeatMilliseconds =
      options.heartbeatMilliseconds ?? JOB_HEARTBEAT_SECONDS * 1_000;
    this.#sink = options.sink ?? process.stderr;
    if (handlersOrDependencies !== undefined && Symbol.iterator in handlersOrDependencies) {
      for (const [id, handler] of handlersOrDependencies) this.#handlers.set(id, handler);
    } else {
      if (handlersOrDependencies === undefined)
        throw new Error('job handler dependencies are required');
      for (const job of generatedJobs) {
        if (!isJobHandlerFactory(job.handlerFactory))
          throw new Error(`invalid job handler factory: ${job.id}`);
        const moduleDependencies =
          job.module === 'core-security'
            ? handlersOrDependencies.coreSecurity
            : handlersOrDependencies.roomsDocuments;
        this.#handlers.set(job.id, job.handlerFactory(moduleDependencies));
      }
    }
  }
  public async runOne(): Promise<boolean> {
    const client = await this.pool.connect();
    let job: LeasedJob | undefined;
    try {
      await client.query('BEGIN');
      const exhausted = await client.query<Pick<LeasedJob, 'id' | 'job_type'>>(
        `SELECT id,job_type FROM job_queue
         WHERE state = 'running' AND lease_expires_at <= transaction_timestamp()
           AND attempts >= max_attempts AND available_at <= transaction_timestamp()
         ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      const exhaustedJob = exhausted.rows[0];
      if (exhaustedJob !== undefined) await finishExhaustion(client, exhaustedJob, this.#sink);
      /* A bulk upload queues one long validation per file; other due work, such as a
         sign-in code, is claimed ahead of that backlog instead of waiting behind it. */
      const result = await client.query<Omit<LeasedJob, 'lease_token'>>(
        `SELECT id,job_type,payload,attempts,max_attempts FROM job_queue
         WHERE attempts < max_attempts AND (
              (state = 'pending' AND available_at <= transaction_timestamp())
           OR (state = 'running' AND lease_expires_at <= transaction_timestamp()))
         ORDER BY job_type = 'document.source.validate',available_at,created_at
         FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      const selected = result.rows[0];
      if (selected === undefined) {
        await client.query('COMMIT');
        return false;
      }
      const leaseToken = createOpaqueId();
      const claimed = await client.query(
        `UPDATE job_queue SET state = 'running',attempts = attempts + 1,lease_owner = $2,
           lease_token = $3,lease_expires_at = transaction_timestamp() + ($4 * interval '1 second'),
           updated_at = transaction_timestamp() WHERE id = $1 AND attempts < max_attempts`,
        [selected.id, this.#owner, leaseToken, this.#leaseSeconds],
      );
      if (claimed.rowCount !== 1) throw new Error('JOB_CLAIM_FAILED');
      const everySeconds = recurrenceSeconds.get(selected.job_type);
      /* Queued with the claim, so a run that fails or exhausts its attempts keeps the
         schedule; keyed by this job, so its retries cannot queue a second successor.
         translate() reproduces the keys earlier releases derived for the same reason. */
      if (everySeconds !== undefined)
        await client.query(
          `INSERT INTO job_queue (id,job_type,idempotency_key,payload,available_at,max_attempts)
           VALUES ($1,$2,translate($2,'._','--')||':'||$3,'{}'::jsonb,
             transaction_timestamp() + ($4 * interval '1 second'),10)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [createOpaqueId(), selected.job_type, selected.id, everySeconds],
        );
      job = { ...selected, attempts: selected.attempts + 1, lease_token: leaseToken };
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const handler = this.#handlers.get(job.job_type);
    if (handler === undefined) {
      await this.fail(job, 'UNKNOWN_JOB_TYPE');
      return true;
    }
    const controller = new AbortController();
    let heartbeatError: Error | undefined;
    const assertLease = async (): Promise<void> => {
      if (heartbeatError !== undefined) throw heartbeatError;
      const result = await this.pool.query(
        `SELECT 1 FROM job_queue WHERE id = $1 AND state = 'running' AND lease_owner = $2
           AND lease_token = $3 AND lease_expires_at > transaction_timestamp()`,
        [job.id, this.#owner, job.lease_token],
      );
      if (result.rowCount !== 1) throw new Error('JOB_LEASE_LOST');
    };
    const heartbeat = setInterval(() => {
      void this.pool
        .query(
          `UPDATE job_queue SET lease_expires_at = transaction_timestamp() + ($4 * interval '1 second'),
             updated_at = transaction_timestamp() WHERE id = $1 AND state = 'running'
             AND lease_owner = $2 AND lease_token = $3 AND lease_expires_at > transaction_timestamp()`,
          [job.id, this.#owner, job.lease_token, this.#leaseSeconds],
        )
        .then((result) => {
          if (result.rowCount !== 1) {
            heartbeatError = new Error('JOB_LEASE_LOST');
            controller.abort();
          }
        })
        .catch(() => {
          heartbeatError = new Error('JOB_LEASE_LOST');
          controller.abort();
        });
    }, this.#heartbeatMilliseconds);
    try {
      await handler(job, { leaseOwner: this.#owner, signal: controller.signal, assertLease });
      await assertLease();
      const completed = await this.pool.query(
        `UPDATE job_queue SET state = 'succeeded',lease_owner = NULL,lease_token = NULL,
           lease_expires_at = NULL,updated_at = transaction_timestamp()
         WHERE id = $1 AND state = 'running' AND lease_owner = $2 AND lease_token = $3
           AND lease_expires_at > transaction_timestamp()`,
        [job.id, this.#owner, job.lease_token],
      );
      if (completed.rowCount !== 1) throw new Error('JOB_LEASE_LOST');
    } catch (error) {
      if (error instanceof Error && error.message === 'JOB_LEASE_LOST') throw error;
      await this.fail(job, 'HANDLER_FAILED');
    } finally {
      clearInterval(heartbeat);
      controller.abort();
    }
    return true;
  }
  public async run(options: {
    readonly signal: AbortSignal;
    readonly pollMilliseconds?: number;
  }): Promise<void> {
    const pollMilliseconds = options.pollMilliseconds ?? 1_000;
    while (!options.signal.aborted) {
      let worked: boolean;
      try {
        worked = await this.runOne();
      } catch {
        // The error is not recorded: a `pg` error carries the connection parameters.
        this.#sink.write(
          `${JSON.stringify(
            allowlistedTelemetry({
              event: 'job.run.failed',
              level: 'warn',
              code: 'JOB_RUN_FAILED',
              service: 'worker',
            }),
          )}\n`,
        );
        worked = false;
      }
      if (!worked) {
        try {
          await delay(pollMilliseconds, undefined, { signal: options.signal });
        } catch {
          break;
        }
      }
    }
  }
  /** A failed last attempt only gives up its lease: the exhaustion sweep in `runOne` then
   * fails the job and runs its hook, the same way it does for a run that crashed. */
  private async fail(job: LeasedJob, code: string): Promise<void> {
    const exhausted = job.attempts >= job.max_attempts;
    const baseSeconds = Math.min(3_600, 2 ** Math.min(job.attempts, 10));
    const delaySeconds = exhausted
      ? 0
      : Math.min(3_600, baseSeconds + randomInt(0, baseSeconds + 1));
    const result = await this.pool.query(
      `UPDATE job_queue SET state = CASE WHEN $4 THEN 'running' ELSE 'pending' END,
         available_at = transaction_timestamp() + ($5 * interval '1 second'),
         lease_owner = CASE WHEN $4 THEN lease_owner END,
         lease_token = CASE WHEN $4 THEN lease_token END,
         lease_expires_at = CASE WHEN $4 THEN transaction_timestamp() END,
         last_error_code = $6,updated_at = transaction_timestamp()
       WHERE id = $1 AND state = 'running' AND lease_owner = $2 AND lease_token = $3
         AND lease_expires_at > transaction_timestamp()`,
      [job.id, this.#owner, job.lease_token, exhausted, delaySeconds, code],
    );
    if (result.rowCount !== 1) throw new Error('JOB_LEASE_LOST');
  }
}
/**
 * Fails a job that has spent its last attempt and runs its declared exhaustion hook in the
 * same transaction, keeping the last recorded error code. When the hook raises, failing the
 * job is undone as well: it stays exhausted with an expired lease, marked
 * EXHAUSTION_HOOK_FAILED so installation status reports it, and is retried later while the
 * rest of the queue keeps moving.
 */
async function finishExhaustion(
  client: PoolClient,
  job: Pick<LeasedJob, 'id' | 'job_type'>,
  sink: SafeProcessSink,
): Promise<void> {
  const hook = exhaustionHooks.get(job.job_type);
  await client.query('SAVEPOINT exhaustion');
  await client.query(
    `UPDATE job_queue SET state = 'failed',lease_owner = NULL,lease_token = NULL,
       lease_expires_at = NULL,updated_at = transaction_timestamp(),
       last_error_code = COALESCE(NULLIF(last_error_code,'EXHAUSTION_HOOK_FAILED'),'ATTEMPTS_EXHAUSTED')
     WHERE id = $1`,
    [job.id],
  );
  try {
    if (hook !== undefined)
      await client.query(`SELECT public.${escapeIdentifier(hook)}($1,$2,$3,$4)`, [
        job.id,
        createOpaqueId(),
        createCorrelationId(),
        createOpaqueId(),
      ]);
  } catch (error) {
    if (!(error instanceof DatabaseError)) throw error;
    await client.query('ROLLBACK TO SAVEPOINT exhaustion');
    await client.query(
      `UPDATE job_queue SET lease_expires_at = transaction_timestamp(),
         available_at = transaction_timestamp() + ($2 * interval '1 second'),
         last_error_code = 'EXHAUSTION_HOOK_FAILED',updated_at = transaction_timestamp()
       WHERE id = $1`,
      [job.id, EXHAUSTION_HOOK_RETRY_SECONDS],
    );
    sink.write(
      `${JSON.stringify(
        allowlistedTelemetry({
          event: 'job.exhaustion.failed',
          level: 'error',
          code: 'EXHAUSTED_WORK_FAILED',
          service: 'worker',
        }),
      )}\n`,
    );
  }
  await client.query('RELEASE SAVEPOINT exhaustion');
}
