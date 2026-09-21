/**
 * The browser names every code the server can record, and nothing else. A code the server
 * gained without the browser would fail every status read; one the browser kept after the
 * server dropped it would be copy nobody can see.
 */
import { describe, expect, it } from 'vitest';
import {
  CHECK_CODES as BROWSER_CODES,
  STATUS_CHECKS as BROWSER_CHECKS,
} from '../../apps/web-client/src/api/status-codes.ts';
import {
  CHECK_CODES as SERVER_CODES,
  STATUS_CHECKS as SERVER_CHECKS,
} from '../../modules/core-security/src/status-observations.ts';

describe('the status code vocabulary', () => {
  it('is the same on both sides of the wire', () => {
    expect(BROWSER_CHECKS).toStrictEqual(SERVER_CHECKS);
    expect(BROWSER_CODES).toStrictEqual(SERVER_CODES);
  });

  it('matches in both directions for every check with exactly 17 total codes', () => {
    expect(BROWSER_CHECKS).toHaveLength(4);
    for (const check of SERVER_CHECKS) {
      const serverList = SERVER_CODES[check];
      const browserList = BROWSER_CODES[check];
      expect(browserList).toBeDefined();
      // Server to browser: no code on server missing from browser
      for (const code of serverList) {
        expect(browserList).toContain(code);
      }
      // Browser to server: no code in browser missing from server
      for (const code of browserList) {
        expect(serverList).toContain(code);
      }
      expect(browserList).toHaveLength(serverList.length);
    }
    const allCodes = Object.values(BROWSER_CODES).flat();
    expect(allCodes).toHaveLength(18);
    const uniqueCodes = new Set(allCodes);
    // STORAGE_UNREACHABLE is shared across storage-privacy and storage-versioning,
    // so there are 18 check-code entries representing exactly 17 distinct codes.
    expect(uniqueCodes.size).toBe(17);
  });
});
