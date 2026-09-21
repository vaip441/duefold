/**
 * Member administration logic tests.
 *
 * Each case pins a rule whose absence would make the surface state something untrue
 * about who can reach what.
 */

import { describe, expect, it } from 'vitest';
import type { MemberRoom, PendingInvitation, ProvisionedMember } from '../api/client.ts';
import {
  assignmentBatch,
  assignmentFailureBelongsTo,
  batchChangesSomething,
  confirmationMatches,
  heldRoles,
  isAdministrable,
  isRoomAssignable,
} from './administration.ts';

function room(id: string): MemberRoom {
  return {
    roomId: id,
    title: `Room ${id}`,
    description: '',
    state: 'draft',
    revision: 1,
    workingRevision: 1,
    publishedRevision: 0,
    roomRole: null,
    accessSource: 'global_role',
    canPublish: true,
  };
}

/** A provisioned member. The only kind that can hold rooms or be administered. */
function subject(overrides: Partial<ProvisionedMember> = {}): ProvisionedMember {
  return {
    subjectKind: 'member',
    subjectId: 'a'.repeat(32),
    emailDisplay: 'Person@example.test',
    globalRole: 'member',
    state: 'active',
    revision: 2,
    createdAt: '2026-09-20T10:00:00.000Z',
    assignments: [],
    ...overrides,
  };
}

/**
 * A pending invitation.
 *
 * Its own factory, because the two kinds are not interchangeable: an invitation has no
 * role it holds and no assignments field at all, so it cannot be produced by overriding
 * a member.
 */
function invitation(overrides: Partial<PendingInvitation> = {}): PendingInvitation {
  return {
    subjectKind: 'invitation',
    subjectId: 'i'.repeat(32),
    emailDisplay: 'Invited@example.test',
    state: 'pending',
    intendedRole: 'member',
    revision: 1,
    createdAt: '2026-09-20T11:00:00.000Z',
    ...overrides,
  };
}

describe('assignmentBatch', () => {
  const rooms = [room('one'), room('two')];

  it('carries only the rooms the draft actually changes', () => {
    /*
     * An unchanged row still fires the session revocation, so repeating one would
     * sign a colleague out of every device for no change at all.
     */
    const held = heldRoles(subject({ assignments: [{ roomId: 'one', roomRole: 'manager' }] }));
    const batch = assignmentBatch({
      rooms,
      held,
      draft: { one: 'manager', two: 'contributor' },
    });
    expect(batch.assign).toStrictEqual([{ roomId: 'two', roomRole: 'contributor' }]);
    expect(batch.revoke).toStrictEqual([]);
  });

  it('expresses removal as "not staffed" rather than a separate action', () => {
    const held = heldRoles(
      subject({ assignments: [{ roomId: 'one', roomRole: 'contributor' }] }),
    );
    const batch = assignmentBatch({ rooms, held, draft: { one: 'none' } });
    expect(batch.revoke).toStrictEqual(['one']);
    expect(batch.assign).toStrictEqual([]);
  });

  it('treats a role change as an assignment, not a revoke plus an assign', () => {
    // Two entries for one room would be a malformed batch the server refuses whole.
    const held = heldRoles(
      subject({ assignments: [{ roomId: 'one', roomRole: 'contributor' }] }),
    );
    const batch = assignmentBatch({ rooms, held, draft: { one: 'manager' } });
    expect(batch.assign).toStrictEqual([{ roomId: 'one', roomRole: 'manager' }]);
    expect(batch.revoke).toStrictEqual([]);
  });

  it('leaves a room outside the register untouched instead of revoking it', () => {
    /*
     * A member can hold an assignment to a room this administrator's register does
     * not list. Treating "not in my list" as "remove it" would strip access the
     * surface never showed and the administrator never chose.
     */
    const held = heldRoles(
      subject({
        assignments: [
          { roomId: 'one', roomRole: 'manager' },
          { roomId: 'elsewhere', roomRole: 'contributor' },
        ],
      }),
    );
    const batch = assignmentBatch({ rooms, held, draft: { one: 'manager' } });
    expect(batch.revoke).not.toContain('elsewhere');
    expect(batchChangesSomething(batch)).toBe(false);
  });

  it('reports an unchanged draft as changing nothing', () => {
    const batch = assignmentBatch({ rooms, held: {}, draft: { one: 'none', two: 'none' } });
    expect(batchChangesSomething(batch)).toBe(false);
  });
});

describe('confirmationMatches', () => {
  it('accepts only the exact phrase', () => {
    expect(confirmationMatches('TRANSFER OWNERSHIP', 'TRANSFER OWNERSHIP')).toBe(true);
  });

  /*
   * Whitespace is NOT forgiven. Trimming looked like tolerating a typing artefact, but it
   * meant the client accepted one string and then submitted a different one, so the
   * server's authoritative check never saw the near miss. A deliberate human gate that
   * silently repairs its own input is not a gate.
   */
  it('refuses leading whitespace', () => {
    expect(confirmationMatches(' TRANSFER OWNERSHIP', 'TRANSFER OWNERSHIP')).toBe(false);
  });

  it('refuses trailing whitespace', () => {
    expect(confirmationMatches('TRANSFER OWNERSHIP ', 'TRANSFER OWNERSHIP')).toBe(false);
  });

  it('refuses whitespace on both sides', () => {
    expect(confirmationMatches('  TRANSFER OWNERSHIP  ', 'TRANSFER OWNERSHIP')).toBe(false);
  });

  it('refuses a newline or tab around the phrase', () => {
    expect(confirmationMatches('\nTRANSFER OWNERSHIP', 'TRANSFER OWNERSHIP')).toBe(false);
    expect(confirmationMatches('TRANSFER OWNERSHIP\t', 'TRANSFER OWNERSHIP')).toBe(false);
  });

  it('refuses whitespace alone', () => {
    expect(confirmationMatches('   ', 'TRANSFER OWNERSHIP')).toBe(false);
  });

  it('refuses a case or wording near miss', () => {
    // A deliberate human gate that accepted a near miss would not be a gate.
    expect(confirmationMatches('transfer ownership', 'TRANSFER OWNERSHIP')).toBe(false);
    expect(confirmationMatches('TRANSFER  OWNERSHIP', 'TRANSFER OWNERSHIP')).toBe(false);
    expect(confirmationMatches('TRANSFER', 'TRANSFER OWNERSHIP')).toBe(false);
  });

  it('refuses everything before the server has issued a phrase', () => {
    // No impact means nothing has been shown, so nothing can be confirmed.
    expect(confirmationMatches('TRANSFER OWNERSHIP', null)).toBe(false);
    expect(confirmationMatches('', null)).toBe(false);
  });
});

/**
 * Which failures the assignment dialog may present.
 *
 * `changeFailure` is one field shared by role, state, invitation-revocation and assignment
 * operations, so a dialog that rendered it unconditionally adopted whatever was reported
 * last. After any failed row mutation, opening room assignment showed that unrelated error
 * as if the fresh draft had been rejected -- and `dismissChangeFailure` was never called
 * anywhere, so nothing cleared it either.
 */
describe('assignmentFailureBelongsTo', () => {
  const MEMBER = 'a'.repeat(32);
  const OTHER = 'b'.repeat(32);

  it('admits this member\u2019s own assignment failure', () => {
    /* Kept across a retry inside the same dialog, which is what lets the draft survive a
       refusal instead of being discarded. */
    expect(
      assignmentFailureBelongsTo({ operation: 'assignment', subjectId: MEMBER }, MEMBER),
    ).toBe(true);
  });

  it('refuses another operation\u2019s failure for the same member', () => {
    // A failed role or state change is reported at the row, not inside a room draft.
    for (const operation of ['role', 'state', 'invitation'] as const)
      expect(
        assignmentFailureBelongsTo({ operation, subjectId: MEMBER }, MEMBER),
        operation,
      ).toBe(false);
  });

  it('refuses another member\u2019s assignment failure', () => {
    // Staffing one colleague must not open holding a refusal about somebody else.
    expect(
      assignmentFailureBelongsTo({ operation: 'assignment', subjectId: OTHER }, MEMBER),
    ).toBe(false);
  });

  it('refuses everything when no failure was reported or no dialog is open', () => {
    expect(assignmentFailureBelongsTo(null, MEMBER)).toBe(false);
    expect(
      assignmentFailureBelongsTo({ operation: 'assignment', subjectId: MEMBER }, null),
    ).toBe(false);
  });
});

describe('isRoomAssignable', () => {
  it('admits an active plain member', () => {
    expect(isRoomAssignable(subject())).toBe(true);
  });

  it('refuses an Owner and an Admin, who already reach every room', () => {
    // An assignment row for them would advertise a narrower role than they keep.
    expect(isRoomAssignable(subject({ globalRole: 'owner' }))).toBe(false);
    expect(isRoomAssignable(subject({ globalRole: 'admin' }))).toBe(false);
  });

  it('refuses a disabled member and a pending invitation', () => {
    expect(isRoomAssignable(subject({ state: 'disabled' }))).toBe(false);
    expect(isRoomAssignable(invitation())).toBe(false);
  });
});

describe('isAdministrable', () => {
  it('admits an admin and a member, in either state', () => {
    expect(isAdministrable(subject({ globalRole: 'admin' }))).toBe(true);
    expect(isAdministrable(subject({ state: 'disabled' }))).toBe(true);
  });

  it('refuses the Owner, whose role moves only through the audited transfer', () => {
    expect(isAdministrable(subject({ globalRole: 'owner' }))).toBe(false);
  });

  it('refuses an invitation, which no role or access change can act on', () => {
    expect(isAdministrable(invitation())).toBe(false);
  });
});
