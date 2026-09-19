import { describe, expect, it } from 'vitest';
import { assertDistinctDatabaseRoleNames } from './database-roles.ts';

describe('database role separation', () => {
  it('fails closed when runtime and authenticator resolve to one credential', () => {
    expect(() => {
      assertDistinctDatabaseRoleNames('duefold_runtime', 'duefold_runtime');
    }).toThrow('DATABASE_ROLE_SEPARATION_REQUIRED');
  });

  it('accepts distinct server-reported roles', () => {
    expect(() => {
      assertDistinctDatabaseRoleNames('duefold_runtime', 'duefold_authenticator');
    }).not.toThrow();
  });
});
