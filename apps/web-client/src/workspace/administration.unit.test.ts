import { describe, expect, it } from 'vitest';
import type { MemberRoom, PendingInvitation, ProvisionedMember } from '../api/client.ts';
import {
  assignmentBatch,
  batchChangesSomething,
  confirmationMatches,
  heldRoles,
  isRoomAssignable,
  isTransferTarget,
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
    capabilities: { setRole: true, setState: true, assignRooms: true, transfer: true },
    ...overrides,
  };
}

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
    const held = heldRoles(
      subject({ assignments: [{ roomId: 'one', roomRole: 'contributor' }] }),
    );
    const batch = assignmentBatch({ rooms, held, draft: { one: 'manager' } });
    expect(batch.assign).toStrictEqual([{ roomId: 'one', roomRole: 'manager' }]);
    expect(batch.revoke).toStrictEqual([]);
  });

  it('leaves a room outside the register untouched instead of revoking it', () => {
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
    expect(confirmationMatches('transfer ownership', 'TRANSFER OWNERSHIP')).toBe(false);
    expect(confirmationMatches('TRANSFER  OWNERSHIP', 'TRANSFER OWNERSHIP')).toBe(false);
    expect(confirmationMatches('TRANSFER', 'TRANSFER OWNERSHIP')).toBe(false);
  });

  it('refuses everything before the server has issued a phrase', () => {
    expect(confirmationMatches('TRANSFER OWNERSHIP', null)).toBe(false);
    expect(confirmationMatches('', null)).toBe(false);
  });
});

const NONE = { setRole: false, setState: false, assignRooms: false, transfer: false };

describe('isRoomAssignable', () => {
  it('admits a member the server said may be assigned rooms', () => {
    expect(isRoomAssignable(subject())).toBe(true);
  });

  it('refuses a member the server withheld the capability from', () => {
    expect(isRoomAssignable(subject({ capabilities: NONE }))).toBe(false);
  });

  it('refuses a pending invitation, which holds nothing to assign', () => {
    expect(isRoomAssignable(invitation())).toBe(false);
  });
});

describe('isTransferTarget', () => {
  it('admits only a subject the server offered transfer for', () => {
    expect(isTransferTarget(subject({ capabilities: { ...NONE, transfer: true } }))).toBe(true);
  });

  it('refuses a subject an Admin is looking at, since transfer is Owner-only', () => {
    expect(isTransferTarget(subject({ capabilities: NONE }))).toBe(false);
  });

  it('refuses an invitation', () => {
    expect(isTransferTarget(invitation())).toBe(false);
  });
});
