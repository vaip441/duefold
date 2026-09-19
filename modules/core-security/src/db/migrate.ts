import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
import type { GeneratedMigration } from '@duefold/composition/registry-types';

export interface AppliedMigration {
  readonly id: string;
  readonly checksum: string;
}

async function ensureLedger(client: PoolClient): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS duefold_migration (
    id text PRIMARY KEY,
    checksum char(64) NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT transaction_timestamp()
  )`);
  await client.query(`CREATE OR REPLACE FUNCTION read_applied_migration_ids()
    RETURNS TABLE(id text)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
      SELECT migration.id FROM duefold_migration migration ORDER BY migration.id
    $$`);
  await client.query('ALTER FUNCTION read_applied_migration_ids() OWNER TO duefold_migration');
  await client.query(
    'REVOKE ALL ON FUNCTION read_applied_migration_ids() FROM PUBLIC,duefold_worker,duefold_authenticator',
  );
  await client.query(
    'GRANT EXECUTE ON FUNCTION read_applied_migration_ids() TO duefold_runtime',
  );
}

/** Ordered, transactional, checksum-pinned migration application. */
export async function migrate(
  pool: Pool,
  migrations: readonly GeneratedMigration[],
): Promise<void> {
  const sorted = [...migrations].sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(sorted.map(({ id }) => id)).size !== sorted.length)
    throw new Error('duplicate migration id');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [739_105_631]);
    await ensureLedger(client);
    const applied = await client.query<AppliedMigration>(
      'SELECT id, checksum FROM duefold_migration ORDER BY id',
    );
    if (applied.rows.length > sorted.length)
      throw new Error('migration ledger is not a registry prefix');
    for (const [index, row] of applied.rows.entries()) {
      if (sorted[index]?.id !== row.id)
        throw new Error('migration ledger is not a registry prefix');
    }
    const ledger = new Map(applied.rows.map(({ id, checksum }) => [id, checksum]));
    for (const migration of sorted) {
      const sql = await readFile(migration.path, 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = ledger.get(migration.id);
      if (existing !== undefined && existing !== checksum) {
        throw new Error(`migration checksum mismatch: ${migration.id}`);
      }
      if (existing === undefined) {
        await client.query(sql);
        await client.query('INSERT INTO duefold_migration (id, checksum) VALUES ($1, $2)', [
          migration.id,
          checksum,
        ]);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
