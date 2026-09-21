import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applicationVersion, compareReleaseVersions } from './release.ts';

describe('applicationVersion', () => {
  it('is the root package version every image carries', () => {
    const root = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { readonly version: string };
    expect(applicationVersion()).toBe(root.version);
  });
});

describe('compareReleaseVersions', () => {
  it('orders numerically, part by part', () => {
    expect(compareReleaseVersions('1.2.0', '1.10.0')).toBeLessThan(0);
    expect(compareReleaseVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareReleaseVersions('1.4.2', '1.4.2')).toBe(0);
  });

  it('refuses to order anything that is not X.Y.Z', () => {
    expect(compareReleaseVersions('1.2', '1.2.0')).toBeNull();
    expect(compareReleaseVersions('1.2.0-rc.1', '1.2.0')).toBeNull();
    expect(compareReleaseVersions('1.2.0', 'latest')).toBeNull();
  });
});
