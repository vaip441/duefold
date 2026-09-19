import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { SecurityDatabase } from './schema.ts';

export function createDatabase(connectionString: string): Kysely<SecurityDatabase> {
  return new Kysely<SecurityDatabase>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString, max: 10, application_name: 'duefold' }),
    }),
  });
}
