/**
 * Playwright configuration.
 *
 * The suite runs against the real Fastify server started per worker by the test
 * harness, over loopback TLS with a self-signed certificate, so the `Secure`
 * session and CSRF cookies behave exactly as they do in production.
 *
 * ENGINE COVERAGE IS THREE ENGINES. Chromium, Gecko, and WebKit are exercised in
 * CI; mobile Chromium separately covers the 320 CSS-pixel responsive boundary.
 * `playwright install --with-deps` is required because WebKit needs GTK and
 * GStreamer libraries that are not part of a minimal Node development host.
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
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
    {
      // Responsive member and viewer states from 320 CSS pixels.
      name: 'mobile-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 320, height: 720 } },
    },
  ],
});
