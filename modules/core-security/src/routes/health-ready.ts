import { Type } from '@sinclair/typebox';
import type { FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import type { GeneratedMigration } from '@duefold/composition/registry-types';
export const schema = {
  response: {
    200: Type.Object(
      {
        status: Type.Literal('ready'),
        checks: Type.Record(Type.String(), Type.String()),
      },
      { additionalProperties: false },
    ),
    503: Type.Object(
      {
        status: Type.Literal('unready'),
        checks: Type.Record(Type.String(), Type.String()),
      },
      { additionalProperties: false },
    ),
  },
};
export interface ReadinessExtension {
  readonly name: 'storage' | 'scanner';
  check(): Promise<{ readonly healthy: boolean; readonly code: string }>;
}
export interface ReadinessDependencies {
  readonly database: Pool;
  readonly extensions: readonly ReadinessExtension[];
  readonly manifestConsistent: () => boolean;
  readonly migrationsApplied: () => Promise<boolean>;
  readonly jobsCompatible: () => Promise<boolean>;
}
export interface ReadinessReport {
  readonly status: 'ready' | 'unready';
  readonly checks: Readonly<Record<string, string>>;
}

export async function allMigrationsApplied(
  database: Pool,
  migrations: readonly GeneratedMigration[],
): Promise<boolean> {
  const applied = await database.query<{ id: string }>(
    'SELECT id FROM read_applied_migration_ids()',
  );
  const expected = [...migrations]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(({ id }) => id);
  return (
    applied.rows.length === expected.length &&
    applied.rows.every(({ id }, index) => id === expected[index])
  );
}

export async function queuedJobsCompatible(
  database: Pool,
  composedJobIds: readonly string[],
): Promise<boolean> {
  const result = await database.query<{ job_type: string }>(
    "SELECT DISTINCT job_type FROM job_queue WHERE state IN ('pending','running')",
  );
  const composed = new Set(composedJobIds);
  return result.rows.every(({ job_type }) => composed.has(job_type));
}

export function createReadinessHandler(
  dependencies: ReadinessDependencies,
): (_request: unknown, reply: FastifyReply) => Promise<ReadinessReport> {
  return async (_request, reply) => {
    const checks: Record<string, string> = {};
    try {
      await dependencies.database.query('SELECT 1');
      checks['postgresql'] = 'ok';
    } catch {
      checks['postgresql'] = 'unavailable';
    }
    checks['manifest'] = dependencies.manifestConsistent() ? 'ok' : 'inconsistent';
    try {
      checks['migrations'] = (await dependencies.migrationsApplied()) ? 'ok' : 'incomplete';
    } catch {
      checks['migrations'] = 'unavailable';
    }
    try {
      checks['jobs'] = (await dependencies.jobsCompatible()) ? 'ok' : 'incompatible';
    } catch {
      checks['jobs'] = 'unavailable';
    }
    for (const extension of dependencies.extensions) {
      try {
        const result = await extension.check();
        checks[extension.name] = result.healthy ? 'ok' : result.code;
      } catch {
        checks[extension.name] = 'unavailable';
      }
    }
    for (const required of ['storage', 'scanner']) checks[required] ??= 'not-composed';
    const report: ReadinessReport = {
      status: Object.values(checks).every((value) => value === 'ok') ? 'ready' : 'unready',
      checks,
    };
    if (report.status === 'unready') reply.code(503);
    return report;
  };
}

export function handler(): never {
  throw new Error('readiness route runtime not initialized');
}
