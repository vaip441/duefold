import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { generatedMigrations } from '../../.duefold/generated/migrations.ts';
import { migrate } from '../../modules/core-security/src/db/migrate.ts';

const bootstrapPool = new Pool({
  host: '/var/run/postgresql',
  database: 'duefold_test',
});
const migrationPool = new Pool({
  connectionString: process.env['DUEFOLD_TEST_MIGRATION_DATABASE_URL'],
});

beforeAll(async () => {
  await bootstrapPool.query(
    'DROP SCHEMA public CASCADE; CREATE SCHEMA public; ALTER SCHEMA public OWNER TO duefold_migration;',
  );
  await migrate(migrationPool, generatedMigrations);
});
afterAll(async () => {
  await migrationPool.end();
  await bootstrapPool.end();
});

describe('lifecycle least privilege and lease fencing', () => {
  it('keeps lifecycle tables private and worker purge functions unreachable to web/auth roles', async () => {
    for (const role of ['duefold_runtime', 'duefold_authenticator']) {
      for (const table of ['viewer_pseudonym', 'room_purge', 'operational_recovery_status'])
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
          expect(
            (
              await migrationPool.query<{ allowed: boolean }>(
                'SELECT has_table_privilege($1,$2,$3) allowed',
                [role, table, privilege],
              )
            ).rows[0]?.allowed,
            `${role} ${privilege} ${table}`,
          ).toBe(false);
      for (const fn of [
        'begin_room_purge(text,text,text,text)',
        'mark_room_purge_marker_written(text,text,text,text)',
        'read_room_purge_viewers(text,text,text,text)',
        'finalize_room_purge(text,text,text,text,jsonb,text,text)',
      ])
        expect(
          (
            await migrationPool.query<{ allowed: boolean }>(
              'SELECT has_function_privilege($1,$2,$3) allowed',
              [role, fn, 'EXECUTE'],
            )
          ).rows[0]?.allowed,
          `${role} EXECUTE ${fn}`,
        ).toBe(false);
    }
    expect(
      (
        await migrationPool.query<{ allowed: boolean }>(
          "SELECT has_function_privilege('duefold_worker','finalize_room_purge(text,text,text,text,jsonb,text,text)','EXECUTE') allowed",
        )
      ).rows[0]?.allowed,
    ).toBe(true);
  });

  it('requires owner, token, and live expiry in every destructive finalizer statement', async () => {
    const source = (
      await migrationPool.query<{ source: string }>(
        "SELECT prosrc source FROM pg_proc WHERE oid='finalize_room_purge(text,text,text,text,jsonb,text,text)'::regprocedure",
      )
    ).rows[0]?.source;
    if (source === undefined) throw new Error('installed finalizer absent');
    const mutations = source
      .split(';')
      .map((statement) => statement.replace(/\s+/gu, ' ').trim())
      .filter((statement) =>
        /^(DELETE FROM|UPDATE (document|viewer|room|room_purge)|INSERT INTO (audit_event|viewer_pseudonym))/u.test(
          statement,
        ),
      );
    expect(mutations.length).toBeGreaterThanOrEqual(20);
    for (const statement of mutations) {
      expect(statement, `owner fence: ${statement}`).toContain('j.lease_owner=p_owner');
      expect(statement, `token fence: ${statement}`).toContain('j.lease_token=p_token');
      expect(statement, `expiry fence: ${statement}`).toContain(
        'j.lease_expires_at>statement_timestamp()',
      );
    }
    expect(source).toContain('p.marker_written_at IS NOT NULL');
  });

  it('has one 011 migration and no duplicate migration ids', () => {
    expect(
      generatedMigrations.filter(({ id }) => id === '011_retention_lifecycle'),
    ).toHaveLength(1);
    expect(new Set(generatedMigrations.map(({ id }) => id)).size).toBe(
      generatedMigrations.length,
    );
  });
});
