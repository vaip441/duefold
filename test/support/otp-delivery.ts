import type { Pool } from 'pg';
import type { FixedClock } from '@duefold/shared/clock';
import { OTP_DELIVERY_JOB } from '../../modules/core-security/src/auth/otp.ts';
import { createHandler as createOtpDeliveryHandler } from '../../modules/core-security/src/jobs/otp-delivery.ts';
import { JobRunner } from '../../apps/worker/src/runner.ts';

/** Runs queued OTP delivery as the worker and returns the code mailed for the challenge. */
export async function deliverChallenge(
  workerPool: Pool,
  challengeId: string,
  clock: FixedClock,
): Promise<string | null> {
  const delivered: { code?: string } = {};
  const handler = createOtpDeliveryHandler({
    pool: workerPool,
    otpDigestKey: Buffer.alloc(32, 1).toString('base64url'),
    clock,
    mailer: {
      deliver: (message) => {
        if (message.challengeId === challengeId) delivered.code = message.code;
        return Promise.resolve();
      },
      close: () => undefined,
    },
  });
  const runner = new JobRunner(workerPool, new Map([[OTP_DELIVERY_JOB, handler]]));
  for (let index = 0; index < 20; index += 1) {
    await runner.runOne();
    if (delivered.code !== undefined) break;
  }
  return delivered.code ?? null;
}
