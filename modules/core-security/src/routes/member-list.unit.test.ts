import { createRequire } from 'node:module';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { schema, type MemberListSubject } from './member-list.ts';

const ajvRequire = createRequire(import.meta.url);
const Ajv = ajvRequire('ajv') as new (options: Readonly<Record<string, unknown>>) => {
  compile: (declared: unknown) => (value: unknown) => boolean;
};

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
const validate = ajv.compile(schema.response[200]);

const MEMBER = {
  subjectKind: 'member',
  subjectId: 'a'.repeat(32),
  emailDisplay: 'person@example.test',
  globalRole: 'member',
  state: 'active',
  revision: 2,
  createdAt: '2026-09-20T10:00:00.000Z',
  assignments: [{ roomId: 'r'.repeat(32), roomRole: 'manager' }],
  capabilities: { setRole: true, setState: true, assignRooms: true, transfer: false },
};

const INVITATION = {
  subjectKind: 'invitation',
  subjectId: 'i'.repeat(32),
  emailDisplay: 'invited@example.test',
  globalRole: 'admin',
  state: 'pending',
  revision: 1,
  createdAt: '2026-09-20T11:00:00.000Z',
};

function accepts(subject: unknown): boolean {
  return validate({ subjects: [subject] });
}

describe('valid records', () => {
  it('accepts a provisioned member with their complete assignment set', () => {
    expect(accepts(MEMBER)).toBe(true);
  });

  it('accepts a disabled member', () => {
    expect(accepts({ ...MEMBER, state: 'disabled' })).toBe(true);
  });

  it('accepts the Owner', () => {
    expect(accepts({ ...MEMBER, globalRole: 'owner' })).toBe(true);
  });

  it('accepts a pending invitation with no assignment field', () => {
    expect(accepts(INVITATION)).toBe(true);
  });
});

describe('the capability set is required, in full', () => {
  it('refuses a member with no capability set', () => {
    const withoutCapabilities: Record<string, unknown> = { ...MEMBER };
    delete withoutCapabilities['capabilities'];
    expect(accepts(withoutCapabilities)).toBe(false);
  });

  it('refuses a partial capability set', () => {
    expect(accepts({ ...MEMBER, capabilities: { setRole: true } })).toBe(false);
  });

  it('refuses a non-boolean flag', () => {
    expect(
      accepts({ ...MEMBER, capabilities: { ...MEMBER.capabilities, transfer: 'yes' } }),
    ).toBe(false);
  });

  it('refuses an invitation carrying capabilities it cannot have', () => {
    expect(accepts({ ...INVITATION, capabilities: MEMBER.capabilities })).toBe(false);
  });
});

describe('semantically impossible records are refused', () => {
  it('refuses an invitation that is active', () => {
    expect(accepts({ ...INVITATION, state: 'active' })).toBe(false);
  });

  it('refuses an invitation that is disabled', () => {
    expect(accepts({ ...INVITATION, state: 'disabled' })).toBe(false);
  });

  it('refuses an invitation claiming the owner role', () => {
    expect(accepts({ ...INVITATION, globalRole: 'owner' })).toBe(false);
  });

  it('refuses an invitation carrying room assignments', () => {
    expect(
      accepts({
        ...INVITATION,
        assignments: [{ roomId: 'r'.repeat(32), roomRole: 'manager' }],
      }),
    ).toBe(false);
  });

  it('refuses an invitation carrying an empty assignment array', () => {
    expect(accepts({ ...INVITATION, assignments: [] })).toBe(false);
  });

  it('refuses a member that is pending', () => {
    expect(accepts({ ...MEMBER, state: 'pending' })).toBe(false);
  });

  it('refuses a member with no assignment set', () => {
    const { assignments, ...withoutAssignments } = MEMBER;
    expect(assignments).toHaveLength(1);
    expect(accepts(withoutAssignments)).toBe(false);
  });

  it('refuses an unknown subject kind', () => {
    expect(accepts({ ...MEMBER, subjectKind: 'service-account' })).toBe(false);
  });

  it('refuses an unknown room role inside an assignment', () => {
    expect(
      accepts({ ...MEMBER, assignments: [{ roomId: 'r'.repeat(32), roomRole: 'owner' }] }),
    ).toBe(false);
  });

  it('refuses any property neither kind declares', () => {
    expect(accepts({ ...MEMBER, intendedRole: 'admin' })).toBe(false);
    expect(accepts({ ...INVITATION, canPublish: true })).toBe(false);
  });
});

describe('page shape', () => {
  it('accepts a page with no cursor, meaning it is provably the last', () => {
    expect(validate({ subjects: [] })).toBe(true);
  });

  it('accepts a page carrying a cursor', () => {
    expect(
      validate({
        subjects: [MEMBER],
        nextCursor: { createdAt: '2026-09-20 10:00:00.123456+00', subjectId: 'a'.repeat(32) },
      }),
    ).toBe(true);
  });

  it('refuses a partial cursor', () => {
    expect(validate({ subjects: [MEMBER], nextCursor: { subjectId: 'a'.repeat(32) } })).toBe(
      false,
    );
  });
});

describe('the wire type refuses what the schema refuses', () => {
  it('keeps the union discriminated rather than flattening it', () => {
    expectTypeOf<Extract<MemberListSubject, { subjectKind: 'member' }>>().toHaveProperty(
      'assignments',
    );
    expectTypeOf<
      Extract<MemberListSubject, { subjectKind: 'invitation' }>
    >().not.toHaveProperty('assignments');
  });

  it('admits only pending for an invitation and only active or disabled for a member', () => {
    expectTypeOf<
      Extract<MemberListSubject, { subjectKind: 'invitation' }>['state']
    >().toEqualTypeOf<'pending'>();
    expectTypeOf<
      Extract<MemberListSubject, { subjectKind: 'member' }>['state']
    >().toEqualTypeOf<'active' | 'disabled'>();
  });

  it('refuses owner on an invitation, which moves only through the audited transfer', () => {
    expectTypeOf<
      Extract<MemberListSubject, { subjectKind: 'invitation' }>['globalRole']
    >().toEqualTypeOf<'admin' | 'member'>();
  });

  it('renders the instant as text without losing the kind', () => {
    expectTypeOf<MemberListSubject['createdAt']>().toEqualTypeOf<string>();
  });

  it('names the invitation role field globalRole on the wire', () => {
    expectTypeOf<Extract<MemberListSubject, { subjectKind: 'invitation' }>>().toHaveProperty(
      'globalRole',
    );
    expectTypeOf<
      Extract<MemberListSubject, { subjectKind: 'invitation' }>
    >().not.toHaveProperty('intendedRole');
  });
});
