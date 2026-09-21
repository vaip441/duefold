import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../authorization.ts';
import {
  readMembers,
  MAX_MEMBER_ASSIGNMENTS,
  MAX_MEMBER_PAGE_LIMIT,
  MEMBER_PAGE_LIMIT,
  type MemberSubject,
  type PendingInvitationSubject,
  type ProvisionedMemberSubject,
} from '../administration.ts';
import { protectedErrorResponses } from './error-envelope.ts';

/**
 * The organization's member list, one bounded keyset page at a time.
 *
 * `audience: 'member'` and no role branch here: `read_members` refuses a plain
 * member itself, so an unauthorized caller receives SQLSTATE 42501 and the uniform
 * 403, never a filtered list assembled in this process. A denial therefore also
 * discloses nothing about whether members exist.
 *
 * Members, pending invitations, and assignments all grow, so the response is paged
 * rather than a full projection (§23). `nextCursor` is echoed back unmodified; it
 * carries the server's exact timestamp text because a millisecond round-trip would
 * truncate the instant and skip subjects created within the same microsecond.
 *
 * EVERY SUBJECT CARRIES ITS COMPLETE ASSIGNMENT SET. There is no partial-access
 * response: the page is bounded by returning fewer SUBJECTS, never by shortening one
 * subject's rooms, so `nextCursor` alone describes what remains. A page bounded that
 * way can be shorter than `limit` and still continue, so a client must follow
 * `nextCursor` rather than stop when a page looks short.
 *
 * `subjectKind` separates provisioned members from pending invitations because
 * `member.state='invited'` is unreachable: acceptance inserts `'active'` directly,
 * so an invited person exists only as an invitation. Rendering the two alike would
 * claim someone has access before they have ever signed in.
 */
const ID = Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' });
/*
 * `createdAt` is the server's exact timestamp text, echoed unmodified rather than
 * reformatted: `timestamptz` carries microseconds and a client `Date` carries
 * milliseconds, so re-serializing it would truncate the instant and skip every
 * subject tied at that microsecond. `format: 'date-time'` is deliberately absent
 * because PostgreSQL's rendering is not RFC 3339 (' ' separator, '+03' offset).
 */
const CURSOR = Type.Object(
  {
    createdAt: Type.String({ minLength: 20, maxLength: 64 }),
    subjectId: ID,
  },
  { additionalProperties: false },
);

const ASSIGNMENT = Type.Object(
  {
    roomId: ID,
    roomRole: Type.Union([Type.Literal('manager'), Type.Literal('contributor')]),
  },
  { additionalProperties: false },
);

const SUBJECT_IDENTITY = {
  subjectId: ID,
  emailDisplay: Type.String({ minLength: 3, maxLength: 320 }),
  revision: Type.Integer({ minimum: 1 }),
  createdAt: Type.String({ format: 'date-time' }),
} as const;

/**
 * A provisioned member: someone who has signed in.
 *
 * `state` is active or disabled. `'pending'` belongs to an invitation, and
 * `member.state='invited'` is unreachable because acceptance inserts `'active'`
 * directly, so neither may appear here.
 */
const MEMBER_SUBJECT = Type.Object(
  {
    subjectKind: Type.Literal('member'),
    ...SUBJECT_IDENTITY,
    globalRole: Type.Union([
      Type.Literal('owner'),
      Type.Literal('admin'),
      Type.Literal('member'),
    ]),
    state: Type.Union([Type.Literal('active'), Type.Literal('disabled')]),
    /* This member's COMPLETE active set, bounded because apply_room_assignments caps
     * one member at this many active assignments and the reader's page budget is the
     * same number. A larger set is a disagreement about the bound, so the handler
     * fails closed rather than answering with a prefix that would read as complete. */
    assignments: Type.Array(ASSIGNMENT, { maxItems: MAX_MEMBER_ASSIGNMENTS }),
  },
  { additionalProperties: false },
);

/**
 * A pending invitation: someone who has never signed in.
 *
 * `state` is exactly `'pending'`, the role is one an invitation may name (never
 * `owner`, which moves only through the audited transfer), and there is NO
 * `assignments` property — `additionalProperties: false` therefore refuses one. An
 * invitation has no member row, so nothing could hold an assignment against it, and an
 * empty array would still have invited the reading that they hold no rooms *yet*.
 */
const INVITATION_SUBJECT = Type.Object(
  {
    subjectKind: Type.Literal('invitation'),
    ...SUBJECT_IDENTITY,
    globalRole: Type.Union([Type.Literal('admin'), Type.Literal('member')]),
    state: Type.Literal('pending'),
  },
  { additionalProperties: false },
);

export const schema = {
  querystring: Type.Object(
    {
      /* A numeric string, because a querystring carries text and `coerceTypes` is
       * deliberately off for every route in this application. */
      limit: Type.Optional(Type.String({ pattern: '^(?:[1-9]|[1-9][0-9]|100)$' })),
      /* Echoed from a previous response's `nextCursor`, unmodified. */
      afterCreatedAt: Type.Optional(Type.String({ minLength: 20, maxLength: 64 })),
      afterSubjectId: Type.Optional(ID),
    },
    { additionalProperties: false },
  ),
  response: {
    200: Type.Object(
      {
        /*
         * A UNION OF TWO KINDS, not one flat record carrying a `subjectKind` label.
         *
         * A flat schema validated each field independently and so admitted rows that
         * cannot exist: an `invitation` that was `active`, held `owner`, and carried
         * assignments, or a `member` that was `pending`. Each is a false statement
         * about access that Fastify would have serialized without complaint. The union
         * refuses them at the boundary, so the wire contract enforces the invariants
         * rather than leaving them to prose and a client that agrees to honour them.
         */
        subjects: Type.Array(Type.Union([MEMBER_SUBJECT, INVITATION_SUBJECT]), {
          maxItems: MAX_MEMBER_PAGE_LIMIT,
        }),
        /* Absent on the last page, so a client cannot request a page that cannot
         * exist and cannot mistake "no more" for "unknown". It is also the ONLY
         * completeness signal a client needs: assignments are never partial, so a
         * page that continues is a page with further subjects and nothing else. */
        nextCursor: Type.Optional(CURSOR),
      },
      { additionalProperties: false },
    ),
    ...protectedErrorResponses(),
  },
};

/**
 * One subject as it goes on the wire: the reader's row with `createdAt` rendered.
 *
 * Applied to each MEMBER OF THE UNION rather than to the union itself. `Omit` over a
 * union collapses it to the properties the two kinds share, which quietly undid the
 * whole point of the discriminated schema: the declared response type then admitted an
 * `invitation` that was `disabled` or an invitation carrying `globalRole: 'owner'`,
 * because `subjectKind` had stopped selecting anything. The schema refused those at
 * serialization time, so the two disagreed and only the schema was load-bearing —
 * leaving the handler free to construct a record the contract forbids.
 */
type Serialized<T extends { readonly createdAt: Date }> = Omit<T, 'createdAt'> & {
  readonly createdAt: string;
};

/** A member or an invitation, still discriminated by `subjectKind`. */
export type MemberListSubject =
  Serialized<ProvisionedMemberSubject> | Serialized<PendingInvitationSubject>;

export interface MemberListResponse {
  readonly subjects: readonly MemberListSubject[];
  readonly nextCursor?: { readonly createdAt: string; readonly subjectId: string };
}

/**
 * Renders one subject's instant, preserving its kind.
 *
 * The kind is narrowed BEFORE the rest is spread. Destructuring a union and spreading
 * the remainder produces an object assembled from the shared properties, which is how
 * the flattened type arose in the first place; narrowing first means each branch builds
 * a record of exactly one kind and the compiler checks it against that kind's rules.
 */
function serialize(subject: MemberSubject): MemberListSubject {
  if (subject.subjectKind === 'invitation') {
    const { createdAt, ...invitation } = subject;
    return { ...invitation, createdAt: createdAt.toISOString() };
  }
  const { createdAt, ...member } = subject;
  return { ...member, createdAt: createdAt.toISOString() };
}

interface Query {
  readonly limit?: string;
  readonly afterCreatedAt?: string;
  readonly afterSubjectId?: string;
}

export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (request: FastifyRequest): Promise<MemberListResponse> => {
    const query = request.query as Query;
    /* Both cursor components are forwarded as given, including a partial one:
     * `read_members` is the authority and refuses it with SQLSTATE 22023, which the
     * failure mapping renders as the designed 400. Refusing it here as well would be
     * a second rule that could drift from the authoritative one. */
    const page = await readMembers({
      pool: runtime.pool,
      identity,
      limit: Number(query.limit ?? String(MEMBER_PAGE_LIMIT)),
      afterCreatedAt: query.afterCreatedAt ?? null,
      afterSubjectId: query.afterSubjectId ?? null,
    });
    return {
      subjects: page.subjects.map((subject) => serialize(subject)),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  };
}
export function handler(): never {
  throw new Error('member list route runtime not initialized');
}
