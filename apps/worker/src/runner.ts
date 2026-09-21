import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { generatedJobs } from '../../../.duefold/generated/jobs.ts';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import type { RequiredMailDeliveryDependencies } from '../../../modules/core-security/src/jobs/required-mail-delivery.ts';
import type { MemberInvitationMailDependencies } from '../../../modules/core-security/src/jobs/member-invitation-mail.ts';
import type { OtpDeliveryDependencies } from '../../../modules/core-security/src/jobs/otp-delivery.ts';
import type { SourceValidationDependencies } from '../../../modules/rooms-documents/src/jobs/source-validation.ts';
import type { RetentionSweepDependencies } from '../../../modules/rooms-documents/src/jobs/retention-sweep.ts';
import type { DerivativeCleanupDependencies } from '../../../modules/rooms-documents/src/jobs/derivative-cleanup.ts';
import type { TrashPurgeDependencies } from '../../../modules/rooms-documents/src/jobs/trash-purge.ts';
import type { WatermarkCleanupDependencies } from '../../../modules/rooms-documents/src/jobs/watermark-cleanup.ts';
import type { PreviewInactivityDependencies } from '../../../modules/rooms-documents/src/jobs/preview-inactivity.ts';
import type { DownloadFinalizerDependencies } from '../../../modules/rooms-documents/src/jobs/download-finalizer.ts';
import type { MultipartReapDependencies } from '../../../modules/rooms-documents/src/jobs/multipart-reap.ts';
import type { RoomPurgeDependencies } from '../../../modules/rooms-documents/src/jobs/room-purge.ts';
import type { ExportGenerationDependencies } from '../../../modules/rooms-documents/src/jobs/export-generation.ts';
import type { ExportCleanupDependencies } from '../../../modules/rooms-documents/src/jobs/export-cleanup.ts';
import type { Pool } from 'pg';

export const JOB_LEASE_SECONDS = 120;
const JOB_HEARTBEAT_SECONDS = 40;
interface JobRunnerOptions {
  readonly leaseSeconds?: number;
  readonly heartbeatMilliseconds?: number;
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
    MemberInvitationMailDependencies;
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
    RoomPurgeDependencies;
}
type JobHandlerFactory = (
  dependencies:
    | (OtpDeliveryDependencies &
        RequiredMailDeliveryDependencies &
        MemberInvitationMailDependencies)
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
        RoomPurgeDependencies),
) => JobHandler;
function isJobHandlerFactory(value: unknown): value is JobHandlerFactory {
  return typeof value === 'function';
}
export class JobRunner {
  readonly #owner = createOpaqueId();
  readonly #handlers = new Map<string, JobHandler>();
  readonly #leaseSeconds: number;
  readonly #heartbeatMilliseconds: number;
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
      await client.query(
        `WITH exhausted AS (
           SELECT id FROM job_queue
           WHERE state = 'running' AND lease_expires_at <= transaction_timestamp()
             AND attempts >= max_attempts
           ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1
         ), terminalized AS (
           UPDATE job_queue j SET state = 'failed',lease_owner = NULL,lease_token = NULL,
             lease_expires_at = NULL,last_error_code = 'ATTEMPTS_EXHAUSTED',updated_at = transaction_timestamp()
           FROM exhausted e WHERE j.id = e.id RETURNING j.job_type,j.payload
         ), invalidated AS (
           UPDATE otp_challenge o SET state = 'invalidated'
           FROM terminalized t WHERE t.job_type = 'auth.otp.deliver'
             AND o.id = t.payload->>'challengeId' AND o.state IN ('awaiting_delivery','pending')
           RETURNING o.id
         )
         INSERT INTO audit_event
           (id,event_type,actor_kind,subject_id,result,reason_code,correlation_id)
         SELECT $1,'auth.otp','system',id,'failure','OTP_DELIVERY_FAILED',$2 FROM invalidated`,
        [createOpaqueId(), createCorrelationId()],
      );
      const result = await client.query<Omit<LeasedJob, 'lease_token'>>(
        `SELECT id,job_type,payload,attempts,max_attempts FROM job_queue
         WHERE attempts < max_attempts AND (
              (state = 'pending' AND available_at <= transaction_timestamp())
           OR (state = 'running' AND lease_expires_at <= transaction_timestamp()))
         ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
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
      const worked = await this.runOne();
      if (!worked) {
        try {
          await delay(pollMilliseconds, undefined, { signal: options.signal });
        } catch {
          break;
        }
      }
    }
  }
  private async fail(job: LeasedJob, code: string): Promise<void> {
    const exhausted = job.attempts >= job.max_attempts;
    const baseSeconds = Math.min(3_600, 2 ** Math.min(job.attempts, 10));
    const delaySeconds = Math.min(3_600, baseSeconds + randomInt(0, baseSeconds + 1));
    const result = await this.pool.query(
      `UPDATE job_queue SET state = $4,available_at = transaction_timestamp() + ($5 * interval '1 second'),
         lease_owner = NULL,lease_token = NULL,lease_expires_at = NULL,last_error_code = $6,
         updated_at = transaction_timestamp() WHERE id = $1 AND state = 'running'
         AND lease_owner = $2 AND lease_token = $3 AND lease_expires_at > transaction_timestamp()`,
      [
        job.id,
        this.#owner,
        job.lease_token,
        exhausted ? 'failed' : 'pending',
        delaySeconds,
        code,
      ],
    );
    if (result.rowCount !== 1) throw new Error('JOB_LEASE_LOST');
  }
}
