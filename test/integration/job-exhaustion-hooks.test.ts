/**
 * The exhaustion hooks modules declare for their jobs, which the runner calls in the
 * transaction that fails a job after its last attempt. Migrations must create every declared
 * hook; the worker does not check at startup, because on Railway it is the container that
 * runs those migrations.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOpaqueId } from '@duefold/shared/ids';
import { generatedJobs } from '../../.duefold/generated/jobs.ts';
import type { GeneratedJob } from '@duefold/composition/registry-types';
import { JobRunner } from '../../apps/worker/src/runner.ts';
import { createHandler as createOtpDeliveryHandler } from '../../modules/core-security/src/jobs/otp-delivery.ts';
import { FixedClock } from '@duefold/shared/clock';
import { closePools, migrationPool, workerPool } from '../authz/support/database.ts';
import { resetRoomSchema } from '../authz/support/room-fixture.ts';

beforeAll(async () => {
  await resetRoomSchema('Exhaustion Hooks');
});
afterAll(closePools);

describe('declared exhaustion hooks', () => {
  it('exist with the fixed signature and are callable by the worker alone', async () => {
    const declared: readonly GeneratedJob[] = generatedJobs;
    const hooks = declared.flatMap(({ onExhausted }) =>
      onExhausted === undefined ? [] : [onExhausted],
    );
    expect(hooks).toStrictEqual([
      'fail_exhausted_otp_delivery',
      'fail_exhausted_document_processing',
    ]);
    for (const hook of hooks)
      expect(
        (
          await migrationPool.query<Record<string, boolean>>(
            `SELECT has_function_privilege('duefold_worker',$1,'EXECUTE') AS worker,
               has_function_privilege('duefold_runtime',$1,'EXECUTE') AS runtime,
               has_function_privilege('duefold_authenticator',$1,'EXECUTE') AS authenticator`,
            [`${hook}(text,text,text,text)`],
          )
        ).rows[0],
        hook,
      ).toStrictEqual({ worker: true, runtime: false, authenticator: false });
  });

  it('invalidate an OTP challenge whose delivery job ran out of attempts', async () => {
    const challengeId = createOpaqueId();
    await migrationPool.query(
      `INSERT INTO otp_challenge(id,email_key,network_period,network_hmac,
         browser_category,os_category,device_category)
       VALUES($1,'exhausted@example.com','2026-10',$2,'chromium','linux','desktop')`,
      [challengeId, 'a'.repeat(64)],
    );
    const jobId = createOpaqueId();
    await migrationPool.query(
      `INSERT INTO job_queue(id,job_type,idempotency_key,payload,state,attempts,max_attempts,
         lease_owner,lease_token,lease_expires_at,available_at)
       VALUES($1,'auth.otp.deliver','exhausted-otp:'||$1,jsonb_build_object('challengeId',$2::text),
         'running',5,5,$3,$4,statement_timestamp()-interval '1 second','2000-01-01')`,
      [jobId, challengeId, createOpaqueId(), createOpaqueId()],
    );

    expect(await new JobRunner(workerPool, new Map()).runOne()).toBe(false);

    expect(
      (
        await migrationPool.query<{ state: string; last_error_code: string }>(
          'SELECT state,last_error_code FROM job_queue WHERE id=$1',
          [jobId],
        )
      ).rows[0],
    ).toStrictEqual({ state: 'failed', last_error_code: 'ATTEMPTS_EXHAUSTED' });
    expect(
      (
        await migrationPool.query<{ state: string }>(
          'SELECT state FROM otp_challenge WHERE id=$1',
          [challengeId],
        )
      ).rows[0]?.state,
    ).toBe('invalidated');
    expect(
      (
        await migrationPool.query<{ reason_code: string }>(
          "SELECT reason_code FROM audit_event WHERE event_type='auth.otp' AND subject_id=$1",
          [challengeId],
        )
      ).rows,
    ).toStrictEqual([{ reason_code: 'OTP_DELIVERY_FAILED' }]);
  });

  it('alone invalidate the challenge when delivery throws on its last attempt', async () => {
    const viewerId = createOpaqueId();
    await migrationPool.query(
      `INSERT INTO viewer(id,email_key,email_display,state,session_family_id)
       VALUES($1,'last-attempt@example.com','last-attempt@example.com','active',$2)`,
      [viewerId, createOpaqueId()],
    );
    const challengeId = createOpaqueId();
    await migrationPool.query(
      `INSERT INTO otp_challenge(id,email_key,viewer_id,network_period,network_hmac,
         browser_category,os_category,device_category)
       VALUES($1,'last-attempt@example.com',$2,'2026-10',$3,'chromium','linux','desktop')`,
      [challengeId, viewerId, 'a'.repeat(64)],
    );
    const jobId = createOpaqueId();
    await migrationPool.query(
      `INSERT INTO job_queue(id,job_type,idempotency_key,payload,attempts,max_attempts,available_at)
       VALUES($1,'auth.otp.deliver','last-attempt-otp:'||$1,jsonb_build_object('challengeId',$2::text),
         4,5,'2000-01-01')`,
      [jobId, challengeId],
    );
    const runner = new JobRunner(
      workerPool,
      new Map([
        [
          'auth.otp.deliver',
          createOtpDeliveryHandler({
            pool: workerPool,
            otpDigestKey: Buffer.alloc(32, 1).toString('base64url'),
            clock: new FixedClock(new Date()),
            mailer: {
              deliver: () => Promise.reject(new Error('fixture mail failure')),
              close: () => undefined,
            },
          }),
        ],
      ]),
    );

    expect(await runner.runOne()).toBe(true);
    expect(await runner.runOne()).toBe(false);

    expect(
      (
        await migrationPool.query<{ state: string; last_error_code: string }>(
          'SELECT state,last_error_code FROM job_queue WHERE id=$1',
          [jobId],
        )
      ).rows[0],
    ).toStrictEqual({ state: 'failed', last_error_code: 'HANDLER_FAILED' });
    expect(
      (
        await migrationPool.query<{ state: string }>(
          'SELECT state FROM otp_challenge WHERE id=$1',
          [challengeId],
        )
      ).rows[0]?.state,
    ).toBe('invalidated');
    expect(
      (
        await migrationPool.query<{ reason_code: string }>(
          "SELECT reason_code FROM audit_event WHERE event_type='auth.otp' AND subject_id=$1",
          [challengeId],
        )
      ).rows,
    ).toStrictEqual([{ reason_code: 'OTP_DELIVERY_FAILED' }]);
  });
});
