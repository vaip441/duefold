/**
 * The member-list response schema.
 *
 * The schema is a security boundary, not documentation. It once validated each field
 * independently and so admitted records that cannot exist: an `invitation` that was
 * `active`, held `owner`, and carried room assignments, or a `member` that was `pending`.
 * Fastify would have serialized every one of them, and each is a false statement about
 * who can reach what.
 *
 * These compile the declared schema with the same validator Fastify uses, so what is
 * asserted is the contract the route actually serializes against rather than a
 * restatement of it.
 */

import { createRequire } from 'node:module';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { schema, type MemberListSubject } from './member-list.ts';

/*
 * `ajv` is CommonJS and exposes the constructor as its module export rather than a named
 * or default one, so it is required rather than imported: the interop shape differs
 * between the bundler and Node, and this needs the same constructor Fastify uses.
 */
const ajvRequire = createRequire(import.meta.url);
const Ajv = ajvRequire('ajv') as new (options: Readonly<Record<string, unknown>>) => {
  compile: (declared: unknown) => (value: unknown) => boolean;
};

/*
 * `date-time` is declared on `createdAt` and is a FORMAT, which this validator does not
 * resolve without the formats package. It is left unknown deliberately: these cases are
 * about the kind/state/role/assignment invariants, and the instants used below are all
 * well-formed anyway. Fastify's own instance does resolve it.
 */
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

describe('semantically impossible records are refused', () => {
  it('refuses an invitation that is active', () => {
    // Active means signed in. An invitation names someone who has not.
    expect(accepts({ ...INVITATION, state: 'active' })).toBe(false);
  });

  it('refuses an invitation that is disabled', () => {
    expect(accepts({ ...INVITATION, state: 'disabled' })).toBe(false);
  });

  it('refuses an invitation claiming the owner role', () => {
    // Ownership moves only through the audited transfer, so no invitation can name it.
    expect(accepts({ ...INVITATION, globalRole: 'owner' })).toBe(false);
  });

  it('refuses an invitation carrying room assignments', () => {
    /*
     * A room privilege against someone with no member row to reference. The invitation
     * member of the union declares no such property and is closed, so the field itself is
     * what makes this unrepresentable rather than a length check.
     */
    expect(
      accepts({
        ...INVITATION,
        assignments: [{ roomId: 'r'.repeat(32), roomRole: 'manager' }],
      }),
    ).toBe(false);
  });

  it('refuses an invitation carrying an empty assignment array', () => {
    // Even empty, the field would invite the reading that they hold no rooms *yet*.
    expect(accepts({ ...INVITATION, assignments: [] })).toBe(false);
  });

  it('refuses a member that is pending', () => {
    // `pending` belongs to an invitation, and `member.state='invited'` is unreachable.
    expect(accepts({ ...MEMBER, state: 'pending' })).toBe(false);
  });

  it('refuses a member with no assignment set', () => {
    /* A member's COMPLETE active set is required. An absent field would read as \"no
       rooms\", which is a claim about access rather than an absence of data. */
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
    // Both members of the union are closed, so a stray field cannot ride along.
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
    // Half a key would resume at an instant that belongs to no row.
    expect(validate({ subjects: [MEMBER], nextCursor: { subjectId: 'a'.repeat(32) } })).toBe(
      false,
    );
  });
});

/**
 * The DECLARED TYPE carries the same invariants as the schema.
 *
 * `Omit<MemberSubject, 'createdAt'>` collapsed the union to the properties both kinds
 * share, so `subjectKind` stopped selecting anything: the handler's return type admitted
 * a `disabled` invitation and an invitation holding `owner`, which the schema refuses at
 * serialization time. Only the schema was then load-bearing, and the handler could build
 * a record the contract forbids and learn about it as a 500 rather than as a type error.
 */
describe('the wire type refuses what the schema refuses', () => {
  it('keeps the union discriminated rather than flattening it', () => {
    /* Narrowing on the discriminant must reach exactly one kind. If the union had
       collapsed, neither branch would have its own properties. */
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
    // The reader returns a `Date`; the wire carries a string. Both kinds convert.
    expectTypeOf<MemberListSubject['createdAt']>().toEqualTypeOf<string>();
  });

  /*
   * `globalRole` IS THE WIRE NAME FOR BOTH KINDS. The invitation's value is the role
   * they will hold on arrival, and the browser renames it to `intendedRole` on receipt,
   * where presenting a promised role as a held one would be the actual mistake. Renaming
   * it here would be a second vocabulary for the same field.
   */
  it('names the invitation role field globalRole on the wire', () => {
    expectTypeOf<Extract<MemberListSubject, { subjectKind: 'invitation' }>>().toHaveProperty(
      'globalRole',
    );
    expectTypeOf<
      Extract<MemberListSubject, { subjectKind: 'invitation' }>
    >().not.toHaveProperty('intendedRole');
  });
});
