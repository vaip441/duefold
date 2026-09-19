/**
 * Playwright configuration.
 *
 * The suite runs against the real Fastify server started per worker by the test
 * harness, over loopback TLS with a self-signed certificate, so the `Secure`
 * session and CSRF cookies behave exactly as they do in production.
 *
 * ENGINE COVERAGE IS TWO ENGINES, NOT THREE. Chromium and Gecko are exercised;
 * `mobile-chromium` is a third PROJECT but the same engine as `chromium`. WebKit is
 * deliberately absent rather than configured-and-skipped: the browser is cached, but
 * launching it needs about twenty-five system libraries this host does not have
 * (libgtk-4, libgraphene, the GStreamer set, libflite, and others) and installing
 * them requires root. A project that cannot start would report success by running
 * nothing, which is worse than an accurate gap.
 *
 * So Safari and iOS behaviour is UNVERIFIED. The release evidence has to say so, and
 * adding the WebKit project is a one-line change once the host can run it.
 */

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'test/browser',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  reporter: process.env['CI'] === undefined ? 'list' : [['list'], ['github']],
  use: {
    // The harness serves a self-signed loopback certificate.
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      // Responsive member and viewer states from 320 CSS pixels.
      name: 'mobile-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 320, height: 720 } },
    },
  ],
});
