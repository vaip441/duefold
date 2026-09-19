import type { Pool } from 'pg';

/**
 * Fails closed when the runtime and authentication pools resolve to the same
 * PostgreSQL principal. Two URLs or aliases for one role still destroy the
 * security boundary, so compare server-reported identities rather than strings.
 */
export function assertDistinctDatabaseRoleNames(
  runtimeRole: string | undefined,
  authenticatorRole: string | undefined,
): void {
  if (
    runtimeRole === undefined ||
    authenticatorRole === undefined ||
    runtimeRole === authenticatorRole
  )
    throw new Error('DATABASE_ROLE_SEPARATION_REQUIRED');
}

export async function assertDistinctDatabaseRoles(
  runtimePool: Pool,
  authenticatorPool: Pool,
): Promise<void> {
  const [runtime, authenticator] = await Promise.all([
    runtimePool.query<{ role: string }>('SELECT current_user role'),
    authenticatorPool.query<{ role: string }>('SELECT current_user role'),
  ]);
  assertDistinctDatabaseRoleNames(runtime.rows[0]?.role, authenticator.rows[0]?.role);
}
