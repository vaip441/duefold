/**
 * The running release: the root `package.json` version, which every image carries. The CLI
 * compares a signed manifest against it, and the status surface reports it.
 */
import { readFileSync } from 'node:fs';

const RELEASE_VERSION = /^([0-9]{1,6})\.([0-9]{1,6})\.([0-9]{1,6})$/u;

export function applicationVersion(): string {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
  );
  const version =
    typeof parsed === 'object' && parsed !== null && 'version' in parsed
      ? parsed.version
      : undefined;
  if (typeof version !== 'string' || !RELEASE_VERSION.test(version))
    throw new Error('APPLICATION_VERSION_INVALID');
  return version;
}

/**
 * Negative, zero or positive as `left` is older than, the same as, or newer than `right`.
 * Null when either is not `X.Y.Z`: a version this cannot order is not guessed at.
 */
export function compareReleaseVersions(left: string, right: string): number | null {
  const a = RELEASE_VERSION.exec(left);
  const b = RELEASE_VERSION.exec(right);
  if (a === null || b === null) return null;
  for (const part of [1, 2, 3]) {
    const difference = Number(a[part]) - Number(b[part]);
    if (difference !== 0) return difference;
  }
  return 0;
}
