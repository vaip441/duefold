import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Test projects:
 *
 * - `unit` runs with no external dependency and must stay fast.
 * - `integration` requires PostgreSQL and the storage/mail/scanner doubles.
 * - `authz` holds the exhaustive authorization matrix: every role, room state,
 *   publication state, grant source, expiry, session state, and download
 *   policy. It is a separate project so it can never be silently skipped.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            '{packages,modules,apps}/**/*.unit.test.ts',
            '{packages,modules,apps}/**/*.unit.test.tsx',
            'test/unit/**/*.test.ts',
          ],
          environment: 'node',
        },
        resolve: {
          alias: {
            // The browser-entry registry is a build-time virtual module emitted
            // by the Vite plugin. Under test it resolves to a real module so the
            // consuming component can be exercised with and without a
            // contribution present.
            'virtual:duefold/browser-entries': resolve(
              import.meta.dirname,
              'test/support/browser-entries.ts',
            ),
          },
        },
      },
      {
        test: {
          name: 'integration',
          include: [
            '{packages,modules,apps}/**/*.integration.test.ts',
            'test/integration/**/*.test.ts',
          ],
          environment: 'node',
          setupFiles: ['test/support/integration-setup.ts'],
          hookTimeout: 60_000,
          testTimeout: 60_000,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: 'authz',
          include: ['test/authz/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['test/support/integration-setup.ts'],
          hookTimeout: 60_000,
          testTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
