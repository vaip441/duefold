import { createResilientPool } from '@duefold/shared/database-pool';
import { Kysely, PostgresDialect } from 'kysely';
import type { SecurityDatabase } from './schema.ts';

export function createDatabase(connectionString: string): Kysely<SecurityDatabase> {
  return new Kysely<SecurityDatabase>({
    dialect: new PostgresDialect({
      pool: createResilientPool({
        role: 'runtime',
        connectionString,
        max: 10,
        application_name: 'duefold',
      }),
    }),
  });
}
