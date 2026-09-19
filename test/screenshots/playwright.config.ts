/**
 * Captures the README screenshots from the real server in the browser test harness.
 *
 * Every room, document, and person in the images is synthetic seed data. Run with
 * `npm run docs:screenshots` after `npm run build`; images land in docs/images.
 */

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.capture.ts',
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    ignoreHTTPSErrors: true,
    viewport: { width: 1360, height: 850 },
    deviceScaleFactor: 2,
  },
});
