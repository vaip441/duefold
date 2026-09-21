/**
 * The database credentials and schema reset every authorization suite needs.
 *
 * WHY THIS IS SEPARATE. Two fixture modules each declared the same five pools, the same
 * `DROP SCHEMA public CASCADE` reset, and the same `currentRevision` helper. The
 * connection strings and their fallbacks are an operational contract — which credential a
 * suite runs as is the whole point of an authorization test — and two copies of that
 * contract can disagree while both keep passing.
 *
 * Each suite resets the schema in its own `beforeAll`, which is safe because
 * `test/authz/**` runs with `fileParallelism: false`: the suites share one database and
 * take it in turns. That per-file reset is what makes a failing case reproducible on its
 * own rather than only after the cases that ran before it.
 */

import { Pool } from 'pg';
import { generatedMigrations } from '../../../.duefold/generated/migrations.ts';
import { migrate } from '../../../modules/core-security/src/db/migrate.ts';

/*
 * Owns the schema teardown. The migration role cannot drop the schema it is connected
 * through, so this connects as the superuser over the local socket.
 */
export const bootstrapPool = new Pool({
  host: '/var/run/postgresql',
  database: 'duefold_test',
  max: 4,
});
export const migrationPool = new Pool({
  connectionString:
    process.env['DUEFOLD_TEST_MIGRATION_DATABASE_URL'] ??
    'postgresql://duefold_migration:duefold_local_migration@127.0.0.1:5432/duefold_test',
  max: 4,
});
/** The web process's credential: SELECT plus EXECUTE on the mutation functions. */
export const databasePool = new Pool({
  connectionString:
    process.env['DUEFOLD_TEST_DATABASE_URL'] ??
    'postgresql://duefold_runtime:duefold_local_runtime@127.0.0.1:5432/duefold_test',
  max: 4,
});
/** The credential an unauthenticated OIDC callback runs as. SELECT only on `member`. */
export const authPool = new Pool({
  connectionString:
    process.env['DUEFOLD_TEST_AUTH_DATABASE_URL'] ??
    'postgresql://duefold_authenticator:duefold_local_authenticator@127.0.0.1:5432/duefold_test',
  max: 4,
});
/*
 * The worker's credential. Sweeps are exercised through it rather than through the
 * migration role: proving the runtime cannot call one is only half of a worker-only grant.
 */
export const workerPool = new Pool({
  connectionString:
    process.env['DUEFOLD_TEST_WORKER_DATABASE_URL'] ??
    'postgresql://duefold_worker:duefold_local_worker@127.0.0.1:5432/duefold_test',
  max: 4,
});

/** Drops and re-migrates `public`, so a suite starts from the declared schema. */
export async function resetSchema(): Promise<void> {
  await bootstrapPool.query(
    'DROP SCHEMA public CASCADE; CREATE SCHEMA public; ALTER SCHEMA public OWNER TO duefold_migration;',
  );
  await migrate(migrationPool, generatedMigrations);
}

/** Closes every pool. Called from each suite's `afterAll`. */
export async function closePools(): Promise<void> {
  await authPool.end();
  await databasePool.end();
  await workerPool.end();
  await migrationPool.end();
  await bootstrapPool.end();
}

/**
 * The target's current revision, for the optimistic-concurrency argument every mutation
 * takes. Read as the migration role: the point is to pass a CORRECT revision, so reading
 * it must not itself depend on what the credential under test may see.
 */
export async function currentRevision(memberId: string): Promise<number> {
  const revision = (
    await migrationPool.query<{ revision: number }>('SELECT revision FROM member WHERE id=$1', [
      memberId,
    ])
  ).rows[0]?.revision;
  if (revision === undefined) throw new Error('member missing');
  return revision;
}
