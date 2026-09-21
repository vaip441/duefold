/**
 * What the generated route registry declares about the member-administration routes.
 *
 * Invariant 4: a protected route is `audience: 'member'` with NO role branch, and
 * PostgreSQL decides Owner/Admin. These read the registry directly, because a route
 * declared with a role in it would be a boundary violation no request-level test could
 * distinguish from a correct refusal.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generatedRoutes } from '../../.duefold/generated/routes.ts';
import { closeRoutePools, seedRouteFixture } from './support/route-fixture.ts';

/* The registry is static, but the suite still seeds: `afterAll` closes the pools, and a
   suite that never migrated would leave the schema as whichever suite ran last left it. */
beforeAll(async () => {
  await seedRouteFixture();
});

afterAll(closeRoutePools);

describe('member administration route declarations', () => {
  it('declares both routes as member-audience with CSRF only on the mutation', () => {
    const list = generatedRoutes.find(({ id }) => id === 'organization.members.list');
    const actions = generatedRoutes.find(({ id }) => id === 'organization.members.actions');
    expect(list).toMatchObject({
      method: 'GET',
      path: '/api/members',
      audience: 'member',
      csrf: false,
    });
    expect(actions).toMatchObject({
      method: 'POST',
      path: '/api/members/actions',
      audience: 'member',
      csrf: true,
    });
  });

  /*
   * §7 requires response schemas to be validated, and both routes previously declared
   * only success statuses. That left every designed 400/401/403/409/500 reply outside
   * validation, and the uniform non-enumerating 403 body is a privacy control whose
   * shape must not be free to drift.
   *
   * Asserted against the INSTALLED generated schema, not the source module, so a
   * declaration that failed to reach the registry fails here.
   */
  it('declares a validated error envelope for every status either route can emit', () => {
    for (const id of ['organization.members.list', 'organization.members.actions'] as const) {
      const route = generatedRoutes.find((entry) => entry.id === id);
      const responses = (route?.schema as { readonly response: Record<string, unknown> })
        .response;
      for (const status of [400, 401, 403, 409, 500]) {
        const envelope = responses[String(status)] as
          | { readonly properties?: { readonly error?: unknown }; readonly required?: unknown }
          | undefined;
        expect(envelope, `${id} ${status}`).toBeDefined();
        expect(envelope?.properties?.error, `${id} ${status} error property`).toBeDefined();
        expect(
          (envelope as { readonly additionalProperties?: unknown }).additionalProperties,
          `${id} ${status} closed`,
        ).toBe(false);
      }
    }
  });

  /*
   * §23 requires a bound on every growing collection, and assignments grow as
   * members x rooms because rooms have no installation cap. The bound is spent on
   * SUBJECTS: a page returns fewer members rather than fewer rooms for one member, so
   * both bounds are asserted against the INSTALLED schema where a client meets them.
   */
  it('bounds the member page and each subject\u2019s complete assignment set', () => {
    const list = generatedRoutes.find(({ id }) => id === 'organization.members.list');
    const listOk = (list?.schema as { readonly response: Record<string, unknown> }).response[
      '200'
    ] as {
      readonly properties: {
        readonly subjects: {
          readonly maxItems?: number;
          /* A UNION of two kinds. A flat item schema validated each field independently
           * and so admitted records that cannot exist: an `invitation` that was active,
           * held `owner`, and carried assignments, or a `member` that was `pending`. */
          readonly items: {
            readonly anyOf: readonly {
              readonly additionalProperties?: boolean;
              readonly required?: readonly string[];
              readonly properties: Readonly<
                Record<
                  string,
                  {
                    readonly const?: string;
                    readonly maxItems?: number;
                    readonly anyOf?: readonly { readonly const?: string }[];
                  }
                >
              >;
            }[];
          };
        };
      };
      readonly required?: readonly string[];
    };
    expect(listOk.properties.subjects.maxItems).toBe(100);
    const kinds = listOk.properties.subjects.items.anyOf;
    expect(kinds).toHaveLength(2);
    const memberKind = kinds.find((kind) => kind.properties['subjectKind']?.const === 'member');
    const invitationKind = kinds.find(
      (kind) => kind.properties['subjectKind']?.const === 'invitation',
    );
    expect(memberKind).toBeDefined();
    expect(invitationKind).toBeDefined();
    /*
     * EACH BRANCH IS CLOSED. Without this the union would be decorative: an open object
     * admits the other kind's fields alongside its own, so an invitation could still
     * arrive carrying assignments and a member could still carry a bare `intendedRole`.
     */
    expect(memberKind?.additionalProperties).toBe(false);
    expect(invitationKind?.additionalProperties).toBe(false);

    /* A member REQUIRES its role, its state, and its complete assignment set. An absent
     * assignment field would read as "no rooms", which is a claim about access rather
     * than an absence of data. */
    expect(memberKind?.required ?? []).toEqual(
      expect.arrayContaining([
        'subjectKind',
        'subjectId',
        'emailDisplay',
        'revision',
        'createdAt',
        'globalRole',
        'state',
        'assignments',
      ]),
    );
    /* The same number apply_room_assignments enforces per member, which is what lets
     * every returned member carry a COMPLETE set rather than a prefix. */
    expect(memberKind?.properties['assignments']?.maxItems).toBe(500);
    /* A member is active or disabled. `pending` belongs to an invitation, and
     * `member.state='invited'` is unreachable through every code path. */
    expect(
      (memberKind?.properties['state']?.anyOf ?? []).map(({ const: value }) => value),
    ).toEqual(['active', 'disabled']);
    /* The Owner appears in this list, so the member branch admits all three roles. */
    expect(
      (memberKind?.properties['globalRole']?.anyOf ?? []).map(({ const: value }) => value),
    ).toEqual(['owner', 'admin', 'member']);

    /* An invitation REQUIRES exactly `pending`, and nothing else is representable. */
    expect(invitationKind?.required ?? []).toEqual(
      expect.arrayContaining([
        'subjectKind',
        'subjectId',
        'emailDisplay',
        'revision',
        'createdAt',
        'globalRole',
        'state',
      ]),
    );
    expect(invitationKind?.properties['state']?.const).toBe('pending');
    /*
     * `globalRole` IS THE WIRE FIELD FOR AN INVITATION TOO, narrowed to the roles an
     * invitation may NAME. Ownership moves only through the audited transfer, so an
     * invitation promising `owner` would advertise an arrival the server cannot honour.
     * The browser renames it to `intendedRole` in its own model, where presenting a
     * promised role as a held one would be the actual mistake; renaming it here would be
     * a second vocabulary for one field.
     */
    expect(
      (invitationKind?.properties['globalRole']?.anyOf ?? []).map(({ const: value }) => value),
    ).toEqual(['admin', 'member']);
    expect(invitationKind?.properties['intendedRole']).toBeUndefined();
    /* An invitation declares NO assignment property, and its object is closed, so the
     * field cannot appear. An invitation has no member row for a room privilege to
     * reference, and an empty array would still have read as "holds none yet". */
    expect(invitationKind?.properties['assignments']).toBeUndefined();
    /* No truncation flag exists, because there is no truncated response to describe:
     * `nextCursor` is the whole completeness contract. A flag saying "something on
     * this page is short" could not name WHICH member, and a short room list reads as
     * that member's whole access. */
    expect(listOk.required ?? []).not.toContain('assignmentsTruncated');
    expect(
      (listOk.properties as Readonly<Record<string, unknown>>)['assignmentsTruncated'],
    ).toBeUndefined();

    /* The apply response calls its set complete, so it is bounded by refusing an
     * over-large batch rather than by truncating. */
    const actions = generatedRoutes.find(({ id }) => id === 'organization.members.actions');
    const actionsOk = (actions?.schema as { readonly response: Record<string, unknown> })
      .response['200'] as {
      readonly anyOf: readonly {
        readonly properties?: {
          readonly assignments?: { readonly maxItems?: number };
          readonly impact?: {
            readonly properties: Readonly<Record<string, { readonly maxItems?: number }>>;
            readonly required?: readonly string[];
          };
        };
      }[];
    };
    const applyShape = actionsOk.anyOf.find(
      (variant) => variant.properties?.assignments !== undefined,
    );
    expect(applyShape?.properties?.assignments?.maxItems).toBe(500);

    /* The ownership preview names the assignments the promotion will revoke. All three
     * fields are REQUIRED: an absent count would read as "no rooms affected", and an
     * omitted truncation flag would let a short list understate the revocation. */
    const previewShape = actionsOk.anyOf.find(
      (variant) => variant.properties?.impact !== undefined,
    )?.properties?.impact;
    expect(previewShape?.required).toEqual(
      expect.arrayContaining([
        'revokedAssignmentCount',
        'revokedAssignments',
        'revokedAssignmentsTruncated',
      ]),
    );
    expect(previewShape?.properties['revokedAssignments']?.maxItems).toBe(100);
  });
});
