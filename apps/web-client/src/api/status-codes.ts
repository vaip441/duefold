/**
 * Every code each status check may answer, as `modules/core-security/src/status-observations.ts`
 * defines it; `test/unit/status-codes.test.ts` holds the two equal. Import-free, so that test
 * can load it outside the browser.
 */
export type StatusCheck = 'storage-privacy' | 'storage-versioning' | 'scanner' | 'updates';

export const STATUS_CHECKS: readonly StatusCheck[] = [
  'storage-privacy',
  'storage-versioning',
  'scanner',
  'updates',
];

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

export type ObservationCode = (typeof CHECK_CODES)[StatusCheck][number];
