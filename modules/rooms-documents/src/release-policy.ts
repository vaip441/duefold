import { createHash } from 'node:crypto';
import type { SourceMediaType } from './source-validation.ts';

export interface FormatAdvisory {
  readonly enabledForNewWork: boolean;
  readonly existingDerivativesSafe: boolean;
}
export type ReleaseFormatPolicy = Readonly<Record<SourceMediaType, FormatAdvisory>>;
const POLICY: ReleaseFormatPolicy = {
  'application/pdf': { enabledForNewWork: true, existingDerivativesSafe: true },
  'image/png': { enabledForNewWork: true, existingDerivativesSafe: true },
  'image/jpeg': { enabledForNewWork: true, existingDerivativesSafe: true },
  'image/webp': { enabledForNewWork: true, existingDerivativesSafe: true },
  'text/plain': { enabledForNewWork: true, existingDerivativesSafe: true },
  'text/csv': { enabledForNewWork: true, existingDerivativesSafe: true },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    // Structural workbook controls are implemented and demonstrated. Enablement
    // awaits independent reviewer acceptance and real-binary
    // qualification; re-enabling must repin the policy digest in the same change.
    enabledForNewWork: false,
    existingDerivativesSafe: true,
  },
  'application/vnd.oasis.opendocument.spreadsheet': {
    enabledForNewWork: false,
    existingDerivativesSafe: true,
  },
};
// Pinned to the policy with XLSX/ODS DISABLED pending workbook-adapter
// qualification. Re-enabling those formats must repin this
// digest in the same change, which is the point: the policy cannot drift
// silently.
const PINNED_POLICY_SHA256 = '3627df24797fc43c1c38d321900053ab7365a5a3c96469ec40fc20a4cb15a599';
function canonicalValue(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number')
    return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('RELEASE_POLICY_INVALID');
}
export function releasePolicyDigest(policy: ReleaseFormatPolicy): string {
  return createHash('sha256').update(canonicalValue(policy), 'utf8').digest('hex');
}
export function assertReleasePolicyIntegrity(policy: ReleaseFormatPolicy = POLICY): void {
  if (releasePolicyDigest(policy) !== PINNED_POLICY_SHA256)
    throw new Error('RELEASE_POLICY_INTEGRITY_FAILED');
}
export function assertFormatEnabled(mediaType: SourceMediaType): void {
  assertReleasePolicyIntegrity();
  if (!POLICY[mediaType].enabledForNewWork) throw new Error('FORMAT_DISABLED_BY_RELEASE');
}
export const releaseFormatPolicy = POLICY;
