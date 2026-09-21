/**
 * The room-list response schema.
 *
 * The schema is a security boundary, not documentation. `roomRole` and `accessSource` are
 * how the product EXPLAINS why a room is reachable, and they are not independent:
 * `read_member_rooms` derives the source from the role with
 * `CASE WHEN a.room_role IS NOT NULL THEN 'assignment' ELSE 'global_role' END`
 * (`006_member_workspace_readers.sql:96`).
 *
 * Validated as two separate fields, the schema admitted pairings the reader cannot emit,
 * and Fastify would have serialized every one of them. Each is a false statement about
 * access: an assignment with no role claims a grant while withholding what was granted,
 * and role-derived reach with an explicit role advertises something narrower than the
 * standing Room Manager authority that reach actually carries.
 *
 * These compile the declared schema with the same validator Fastify uses, so what is
 * asserted is the contract the route really serializes against.
 */

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { schema } from './room-list.ts';

/*
 * `ajv` is CommonJS and exposes the constructor as its module export rather than a named
 * or default one, so it is required rather than imported: the interop shape differs
 * between the bundler and Node, and this needs the same constructor Fastify uses.
 */
const ajvRequire = createRequire(import.meta.url);
const Ajv = ajvRequire('ajv') as new (options: Readonly<Record<string, unknown>>) => {
  compile: (declared: unknown) => (value: unknown) => boolean;
};

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
const validate = ajv.compile(schema.response[200]);
const validateQuery = ajv.compile(schema.querystring);

const IDENTITY = {
  roomId: 'r'.repeat(32),
  title: 'Series A',
  description: 'Diligence materials',
  state: 'draft',
  revision: 1,
  workingRevision: 1,
  publishedRevision: 0,
  canPublish: true,
};

/** Staffed by a colleague, so the role they were staffed as is present. */
const ASSIGNED = { ...IDENTITY, accessSource: 'assignment', roomRole: 'manager' };
/** Reached through an organization role, which carries authority everywhere. */
const ROLE_DERIVED = {
  ...IDENTITY,
  roomId: 'g'.repeat(32),
  accessSource: 'global_role',
  roomRole: null,
};

function accepts(room: unknown): boolean {
  return validate({ rooms: [room] });
}

describe('coherent access provenance', () => {
  it('accepts an assignment naming the role it staffed', () => {
    expect(accepts(ASSIGNED)).toBe(true);
    expect(accepts({ ...ASSIGNED, roomRole: 'contributor' })).toBe(true);
  });

  it('accepts role-derived access with no explicit room role', () => {
    expect(accepts(ROLE_DERIVED)).toBe(true);
  });

  it('accepts a page mixing both provenances', () => {
    expect(validate({ rooms: [ASSIGNED, ROLE_DERIVED] })).toBe(true);
  });
});

describe('contradictory access provenance is refused', () => {
  it('refuses an assignment that carries no role', () => {
    // A grant with nothing granted. The reader cannot produce this.
    expect(accepts({ ...ASSIGNED, roomRole: null })).toBe(false);
  });

  it('refuses role-derived access that names an explicit role', () => {
    // Would advertise something narrower than the authority actually held.
    expect(accepts({ ...ROLE_DERIVED, roomRole: 'manager' })).toBe(false);
    expect(accepts({ ...ROLE_DERIVED, roomRole: 'contributor' })).toBe(false);
  });

  it('refuses an unknown access source', () => {
    expect(accepts({ ...ASSIGNED, accessSource: 'inherited' })).toBe(false);
  });

  it('refuses an unknown room role inside an assignment', () => {
    // `owner` is not a room role; ownership is an organization role.
    expect(accepts({ ...ASSIGNED, roomRole: 'owner' })).toBe(false);
  });

  it('refuses a room that omits its access source or role', () => {
    const { accessSource, ...withoutSource } = ASSIGNED;
    expect(accessSource).toBe('assignment');
    expect(accepts(withoutSource)).toBe(false);
    const { roomRole, ...withoutRole } = ASSIGNED;
    expect(roomRole).toBe('manager');
    expect(accepts(withoutRole)).toBe(false);
  });

  it('refuses any property neither provenance declares', () => {
    // Both members of the union are closed, so a stray field cannot ride along.
    expect(accepts({ ...ASSIGNED, inheritedFrom: 'elsewhere' })).toBe(false);
    expect(accepts({ ...ROLE_DERIVED, roomRoleExplain: 'owner' })).toBe(false);
  });

  it('refuses an unrecognized room state', () => {
    // Room state decides whether viewers can reach anything.
    expect(accepts({ ...ASSIGNED, state: 'frozen' })).toBe(false);
  });
});

describe('page shape', () => {
  it('bounds the page, because rooms have no installation cap', () => {
    const declared = schema.response[200] as {
      readonly properties: { readonly rooms: { readonly maxItems?: number } };
    };
    expect(declared.properties.rooms.maxItems).toBe(100);
  });

  it('accepts a page with no cursor, meaning it is provably the last', () => {
    expect(validate({ rooms: [] })).toBe(true);
  });

  it('accepts a page carrying a whole cursor', () => {
    expect(
      validate({
        rooms: [ASSIGNED],
        nextCursor: { title: 'Series A', roomId: 'r'.repeat(32) },
      }),
    ).toBe(true);
  });

  it('refuses a partial cursor', () => {
    // Half a key resumes at a position in neither ordering.
    expect(validate({ rooms: [ASSIGNED], nextCursor: { title: 'Series A' } })).toBe(false);
  });
});

/**
 * The querystring decides the both-or-neither cursor rule.
 *
 * It lives in the schema rather than the handler because a handler that threw for this
 * produced HTTP 500 through the failure mapping: a malformed request answered as a
 * crashed one, and a logged fault for a request correctly rejected.
 */
describe('cursor parameters travel together', () => {
  it('accepts no cursor, and a limit on its own', () => {
    expect(validateQuery({})).toBe(true);
    expect(validateQuery({ limit: '50' })).toBe(true);
  });

  it('accepts a whole cursor, with or without a limit', () => {
    expect(validateQuery({ afterTitle: 'Series A', afterRoomId: 'r'.repeat(32) })).toBe(true);
    expect(
      validateQuery({ limit: '10', afterTitle: 'Series A', afterRoomId: 'r'.repeat(32) }),
    ).toBe(true);
  });

  it('refuses half a cursor', () => {
    expect(validateQuery({ afterTitle: 'Series A' })).toBe(false);
    expect(validateQuery({ afterRoomId: 'r'.repeat(32) })).toBe(false);
    expect(validateQuery({ limit: '10', afterTitle: 'Series A' })).toBe(false);
  });

  it('refuses a limit outside the bound and an unknown parameter', () => {
    for (const limit of ['0', '101', '007', 'abc', ''])
      expect(validateQuery({ limit }), limit).toBe(false);
    expect(validateQuery({ unexpected: '1' })).toBe(false);
  });
});
