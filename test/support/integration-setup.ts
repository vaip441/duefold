/**
 * Integration and authorization-matrix harness bootstrap.
 *
 * Requires a reachable PostgreSQL instance. It fails loudly rather than
 * skipping, because a silently skipped authorization test is worse than a
 * failing one.
 */

const runtimeUrl = process.env['DUEFOLD_TEST_DATABASE_URL'];
const authUrl = process.env['DUEFOLD_TEST_AUTH_DATABASE_URL'];
const workerUrl = process.env['DUEFOLD_TEST_WORKER_DATABASE_URL'];
const migrationUrl = process.env['DUEFOLD_TEST_MIGRATION_DATABASE_URL'];

if (runtimeUrl === undefined || runtimeUrl === '') {
  throw new Error(
    'DUEFOLD_TEST_DATABASE_URL is required for integration and authz tests. ' +
      'See .env.example.',
  );
}
if (authUrl === undefined || authUrl === '') {
  throw new Error(
    'DUEFOLD_TEST_AUTH_DATABASE_URL is required for integration and authz tests. ' +
      'See .env.example.',
  );
}
if (workerUrl === undefined || workerUrl === '') {
  throw new Error(
    'DUEFOLD_TEST_WORKER_DATABASE_URL is required for integration and authz tests. ' +
      'See .env.example.',
  );
}
if (migrationUrl === undefined || migrationUrl === '') {
  throw new Error(
    'DUEFOLD_TEST_MIGRATION_DATABASE_URL is required for integration and authz tests. ' +
      'See .env.example.',
  );
}
