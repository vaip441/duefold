/**
 * The hourly observation of what only the worker can see: whether the bucket refuses
 * strangers, whether it keeps versions, and how old the scanner's signatures are.
 */
import type { Pool } from 'pg';
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
  return async (): Promise<void> => {
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
  };
}
