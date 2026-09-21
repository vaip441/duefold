/**
 * The status checks only the worker or an operator can make, the codes each may answer, and
 * the one writer each is allowed. A code decides its result, so the pair cannot disagree.
 */
import type { Pool } from 'pg';

export type ObservationResult = 'pass' | 'attention' | 'fail';
export type WorkerCheck = 'storage-privacy' | 'storage-versioning' | 'scanner';
export type StatusCheck = WorkerCheck | 'updates';

/** Display order, which `read_status_observations` also answers in. */
export const STATUS_CHECKS: readonly StatusCheck[] = [
  'storage-privacy',
  'storage-versioning',
  'scanner',
  'updates',
];

/** Every code each check may answer. The browser mirrors it (`test/unit/status-codes.test.ts`). */
export const CHECK_CODES = {
  'storage-privacy': [
    'ANONYMOUS_ACCESS_REFUSED',
    'ANONYMOUS_READ_ALLOWED',
    'ANONYMOUS_LIST_ALLOWED',
    'STORAGE_PROBE_INCONCLUSIVE',
    'STORAGE_UNREACHABLE',
  ],
  'storage-versioning': [
    'VERSIONING_ENABLED',
    'VERSIONING_SUSPENDED',
    'VERSIONING_NEVER_ENABLED',
    'VERSIONING_NOT_DETECTABLE',
    'STORAGE_UNREACHABLE',
  ],
  scanner: ['SIGNATURES_CURRENT', 'SIGNATURES_STALE', 'SCANNER_UNAVAILABLE'],
  updates: [
    'UPDATE_CURRENT',
    'UPDATE_AVAILABLE',
    'SECURITY_ADVISORY',
    'UPDATE_MANIFEST_UNVERIFIED',
    'UPDATE_VERSION_UNRECOGNIZED',
  ],
} as const satisfies Readonly<Record<StatusCheck, readonly string[]>>;

export type StoragePrivacyCode = (typeof CHECK_CODES)['storage-privacy'][number];
export type StorageVersioningCode = (typeof CHECK_CODES)['storage-versioning'][number];
export type ScannerCode = (typeof CHECK_CODES)['scanner'][number];
export type UpdateCode = (typeof CHECK_CODES)['updates'][number];
export type ObservationCode = (typeof CHECK_CODES)[StatusCheck][number];

/* Every code's result. A code missing here, or one no check answers, fails to compile. */
const RESULT: Readonly<Record<ObservationCode, ObservationResult>> = {
  ANONYMOUS_ACCESS_REFUSED: 'pass',
  ANONYMOUS_READ_ALLOWED: 'fail',
  ANONYMOUS_LIST_ALLOWED: 'fail',
  STORAGE_PROBE_INCONCLUSIVE: 'attention',
  STORAGE_UNREACHABLE: 'fail',
  VERSIONING_ENABLED: 'pass',
  VERSIONING_SUSPENDED: 'attention',
  VERSIONING_NEVER_ENABLED: 'attention',
  VERSIONING_NOT_DETECTABLE: 'attention',
  SIGNATURES_CURRENT: 'pass',
  SIGNATURES_STALE: 'fail',
  SCANNER_UNAVAILABLE: 'fail',
  UPDATE_CURRENT: 'pass',
  UPDATE_AVAILABLE: 'attention',
  SECURITY_ADVISORY: 'fail',
  UPDATE_MANIFEST_UNVERIFIED: 'fail',
  UPDATE_VERSION_UNRECOGNIZED: 'attention',
};

export function observationResult(code: ObservationCode): ObservationResult {
  return RESULT[code];
}

export type WorkerObservation =
  | { readonly check: 'storage-privacy'; readonly code: StoragePrivacyCode }
  | { readonly check: 'storage-versioning'; readonly code: StorageVersioningCode }
  | {
      readonly check: 'scanner';
      readonly code: ScannerCode;
      /** The signature build time clamd reported; null when it could not be asked. */
      readonly signaturesBuiltAt: Date | null;
    };

export interface UpdateObservation {
  readonly code: UpdateCode;
  /** The release a newer signed manifest offers; null when none is offered. */
  readonly offeredVersion: string | null;
}

type Queryable = Pick<Pool, 'query'>;

export async function recordWorkerObservation(
  pool: Queryable,
  observation: WorkerObservation,
): Promise<void> {
  await pool.query('SELECT record_worker_status_observation($1,$2,$3,$4)', [
    observation.check,
    RESULT[observation.code],
    observation.code,
    observation.check === 'scanner' ? observation.signaturesBuiltAt : null,
  ]);
}

export async function recordUpdateObservation(
  pool: Queryable,
  observation: UpdateObservation,
): Promise<void> {
  await pool.query('SELECT record_update_observation($1,$2,$3)', [
    RESULT[observation.code],
    observation.code,
    observation.offeredVersion,
  ]);
}
