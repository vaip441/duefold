import type { Clock } from '@duefold/shared/clock';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import type { Pool } from 'pg';
import type { OtpMailer } from '../auth/mail.ts';
import { digestOtp, generateOtp, OTP_LIFETIME_SECONDS } from '../auth/otp.ts';
import type { JobContext, LeasedJob } from '../../../../apps/worker/src/runner.ts';

export interface OtpDeliveryDependencies {
  readonly pool: Pool;
  readonly otpDigestKey: string;
  readonly mailer: OtpMailer;
  readonly clock: Clock;
}
function challengeId(payload: Readonly<Record<string, unknown>>): string {
  const value = payload['challengeId'];
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{32}$/u.test(value))
    throw new Error('INVALID_JOB_PAYLOAD');
  return value;
}

export function createHandler(dependencies: OtpDeliveryDependencies) {
  return async (job: LeasedJob, context: JobContext): Promise<void> => {
    const id = challengeId(job.payload);
    const code = generateOtp();
    const expiresAt = new Date(
      dependencies.clock.now().getTime() + OTP_LIFETIME_SECONDS * 1_000,
    );
    const prepared = await dependencies.pool.query<{
      email_display: string | null;
      state: 'pending' | 'invalidated';
    }>(
      `WITH eligible AS (
         SELECT v.email_display FROM otp_challenge o
         JOIN viewer v ON v.id = o.viewer_id AND v.state = 'active'
         WHERE o.id = $1
       ), prepared AS (
         UPDATE otp_challenge o
            SET digest = CASE WHEN e.email_display IS NULL THEN NULL ELSE $4::text END,
                expires_at = CASE WHEN e.email_display IS NULL THEN NULL ELSE $5::timestamptz END,
                state = CASE WHEN e.email_display IS NULL THEN 'invalidated' ELSE 'pending' END
           FROM job_queue j
           LEFT JOIN eligible e ON true
          WHERE o.id = $1 AND j.id = $2 AND j.state = 'running'
            AND j.lease_owner = $3 AND j.lease_token = $6
            AND j.lease_expires_at > transaction_timestamp()
            AND o.state IN ('awaiting_delivery','pending')
          RETURNING o.id,o.state,e.email_display
       ), audited AS (
         INSERT INTO audit_event
           (id,event_type,actor_kind,subject_id,result,reason_code,correlation_id)
         SELECT $7,'auth.otp','system',id,'failure','OTP_DELIVERY_FAILED',$8
           FROM prepared WHERE state = 'invalidated'
       )
       SELECT email_display,state FROM prepared`,
      [
        id,
        job.id,
        context.leaseOwner,
        digestOtp(code, dependencies.otpDigestKey),
        expiresAt,
        job.lease_token,
        createOpaqueId(),
        createCorrelationId(),
      ],
    );
    const challenge = prepared.rows[0];
    if (challenge === undefined) {
      await context.assertLease();
      return;
    }
    if (challenge.state === 'invalidated' || challenge.email_display === null) return;
    try {
      await dependencies.mailer.deliver({
        emailDisplay: challenge.email_display,
        code,
        challengeId: id,
      });
    } catch (error) {
      if (job.attempts >= job.max_attempts) {
        const invalidated = await dependencies.pool.query(
          `WITH invalidated AS (
             UPDATE otp_challenge o SET state = 'invalidated'
              FROM job_queue j
             WHERE o.id = $1 AND j.id = $2 AND j.state = 'running'
               AND j.lease_owner = $3 AND j.lease_token = $4
               AND j.lease_expires_at > transaction_timestamp()
               AND o.state IN ('awaiting_delivery','pending')
             RETURNING o.id
           )
           INSERT INTO audit_event
             (id,event_type,actor_kind,subject_id,result,reason_code,correlation_id)
           SELECT $5,'auth.otp','system',id,'failure','OTP_DELIVERY_FAILED',$6
             FROM invalidated`,
          [
            id,
            job.id,
            context.leaseOwner,
            job.lease_token,
            createOpaqueId(),
            createCorrelationId(),
          ],
        );
        if (invalidated.rowCount !== 1) throw new Error('JOB_LEASE_LOST', { cause: error });
      }
      throw error;
    }
  };
}
