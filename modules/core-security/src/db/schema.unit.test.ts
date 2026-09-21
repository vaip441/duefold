import { describe, expectTypeOf, it } from 'vitest';
import type { Insertable, Selectable, Updateable } from 'kysely';
import type { InvitationTable } from './schema.ts';

/*
 * These are compile-time assertions: the value under test is the table type, not
 * runtime behaviour. A regression fails `tsc` and this file, not a query at
 * runtime against a live database.
 */
describe('invitation column types', () => {
  it('lets a viewer invitation omit the member-only columns', () => {
    /* A viewer invitation must supply neither column: the migration's
     * invitation_role_matches_kind requires intended_global_role to be null for
     * kind='viewer', and no viewer invitation has an inviting Admin recorded on
     * it. Requiring an explicit null here would force every viewer call site to
     * name columns that do not apply to it. */
    const viewer: Insertable<InvitationTable> = {
      id: 'inv',
      kind: 'viewer',
      email_key: 'investor@example.test',
      email_display: 'Investor@example.test',
      state: 'pending',
      expires_at: new Date(),
    };
    expectTypeOf(viewer).toExtend<{ kind: 'member' | 'viewer' }>();
    /* Optional, and still accepting an explicit role for a member invitation. */
    expectTypeOf<Insertable<InvitationTable>>().toExtend<{
      intended_global_role?: 'admin' | 'member' | null;
      invited_by?: string | null;
    }>();
    const member: Insertable<InvitationTable> = {
      ...viewer,
      kind: 'member',
      intended_global_role: 'admin',
      invited_by: 'owner',
    };
    expectTypeOf(member).toBeObject();
  });

  it('still reports both columns as nullable on select', () => {
    /* Optional on insert must not become optional on read: a selected row always
     * has the property, and a consumer must handle the null rather than treat an
     * absent role as an admin role. */
    expectTypeOf<Selectable<InvitationTable>>().toExtend<{
      intended_global_role: 'admin' | 'member' | null;
      invited_by: string | null;
    }>();
    expectTypeOf<Selectable<InvitationTable>['intended_global_role']>().toEqualTypeOf<
      'admin' | 'member' | null
    >();
    expectTypeOf<Selectable<InvitationTable>['invited_by']>().toEqualTypeOf<string | null>();
    expectTypeOf<Updateable<InvitationTable>['intended_global_role']>().toEqualTypeOf<
      'admin' | 'member' | null | undefined
    >();
  });
});
