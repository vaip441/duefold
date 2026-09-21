/**
 * The hourly observation of what only the worker can see: whether the bucket refuses
 * strangers, whether it keeps versions, and how old the scanner's signatures are.
 *
 * Self-rescheduling like `ownership.preview.purge`: the next run is queued inside the lease
 * that performed this one, so a crashed worker does not end the schedule and a lost lease
 * cannot start a second one.
 */
import type { Pool } from 'pg';
import { createOpaqueId } from '@duefold/shared/ids';
import type { JobContext, LeasedJob } from '../../../../apps/worker/src/runner.ts';
import {
  recordWorkerObservation,
  type WorkerObservation,
} from '../../../core-security/src/status-observations.ts';
import { signaturesCurrent, type ClamAvClient } from '../scanning/clamav.ts';
import type { StorageStatusProbe } from '../storage/status-probe.ts';

export interface StatusObserveDependencies {
  readonly pool: Pool;
  readonly storageProbe: StorageStatusProbe;
  readonly scanner: Pick<ClamAvClient, 'readSignatures'>;
}

export async function scannerObservation(
  scanner: Pick<ClamAvClient, 'readSignatures'>,
  now: Date,
): Promise<Extract<WorkerObservation, { readonly check: 'scanner' }>> {
  let signatureDate: Date;
  try {
    ({ signatureDate } = await scanner.readSignatures());
  } catch {
    /* Unreachable, timed out, or an unreadable reply: in each case it cannot scan. */
    return { check: 'scanner', code: 'SCANNER_UNAVAILABLE', signaturesBuiltAt: null };
  }
  return {
    check: 'scanner',
    code: signaturesCurrent(signatureDate, now) ? 'SIGNATURES_CURRENT' : 'SIGNATURES_STALE',
    signaturesBuiltAt: signatureDate,
  };
}

export function createHandler(dependencies: StatusObserveDependencies) {
  return async (job: LeasedJob, context: JobContext): Promise<void> => {
    const [privacy, versioning, scanner] = await Promise.all([
      dependencies.storageProbe.privacy(),
      dependencies.storageProbe.versioning(),
      scannerObservation(dependencies.scanner, new Date()),
    ]);
    await recordWorkerObservation(dependencies.pool, {
      check: 'storage-privacy',
      code: privacy,
    });
    await recordWorkerObservation(dependencies.pool, {
      check: 'storage-versioning',
      code: versioning,
    });
    await recordWorkerObservation(dependencies.pool, scanner);
    await context.assertLease();
    const scheduled = await dependencies.pool.query(
      `INSERT INTO job_queue(id,job_type,idempotency_key,payload,available_at,max_attempts)
       SELECT $4,'status.observe','status-observe:'||$1,'{}'::jsonb,
         statement_timestamp()+interval '1 hour',10
       FROM job_queue j WHERE j.id=$1 AND j.state='running' AND j.lease_owner=$2
         AND j.lease_token=$3 AND j.lease_expires_at>statement_timestamp()`,
      [job.id, context.leaseOwner, job.lease_token, createOpaqueId()],
    );
    if (scheduled.rowCount !== 1) throw new Error('JOB_LEASE_LOST');
  };
}
