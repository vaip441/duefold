import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import {
  readMemberRooms,
  MAX_ROOM_PAGE_LIMIT,
  ROOM_PAGE_LIMIT,
  type MemberRoom,
  type MemberRoomCursor,
} from '../workspace-reads.ts';

/**
 * The member's room list.
 *
 * `accessSource` states WHY a room is reachable. An owner or admin can mutate
 * every room in the installation without any room_assignment, so a list filtered
 * on that predicate alone would silently mean "every room". The workspace labels
 * a role-derived room as such rather than implying a colleague assigned it.
 *
 * Archived rooms are included with their state: members still need to reach
 * records. `canPublish` is the server's decision, echoed so the
 * client never offers a control the server will reject — it is not a permission
 * the client may act on by itself.
 *
 * ONE BOUNDED KEYSET PAGE (§23). Rooms grow without an installation cap and an Owner or
 * Admin reaches every one, so a full projection was a response and a render that grew
 * without limit. `nextCursor` is present only when a further page provably exists, and
 * it is the whole completeness contract: a client that stops before following it is
 * looking at a prefix, which matters most where this list decides staffing.
 */
const ROOM_CURSOR = Type.Object(
  { title: Type.String({ minLength: 1, maxLength: 200 }), roomId: Type.String() },
  { additionalProperties: false },
);

/* Everything about a room that does not depend on WHY it is reachable. */
const ROOM_IDENTITY = {
  roomId: Type.String(),
  title: Type.String(),
  description: Type.String(),
  state: Type.Union([
    Type.Literal('draft'),
    Type.Literal('published'),
    Type.Literal('archived'),
  ]),
  revision: Type.Integer(),
  workingRevision: Type.Integer(),
  publishedRevision: Type.Integer(),
  canPublish: Type.Boolean(),
} as const;

/**
 * A room reached through an explicit assignment: a colleague staffed this member into it,
 * so the ROLE they were staffed as is required and cannot be null.
 */
const ASSIGNED_ROOM = Type.Object(
  {
    ...ROOM_IDENTITY,
    accessSource: Type.Literal('assignment'),
    roomRole: Type.Union([Type.Literal('manager'), Type.Literal('contributor')]),
  },
  { additionalProperties: false },
);

/**
 * A room reached through an organization role, which carries Room Manager authority in
 * every room. `roomRole` is exactly `null`: an explicit role here would advertise
 * something NARROWER than the authority actually held.
 */
const ROLE_DERIVED_ROOM = Type.Object(
  { ...ROOM_IDENTITY, accessSource: Type.Literal('global_role'), roomRole: Type.Null() },
  { additionalProperties: false },
);

/**
 * A UNION ON ACCESS PROVENANCE, not one flat record with two independent fields.
 *
 * `read_member_rooms` derives the source from the role, so the pair is one fact. A flat
 * schema validated each half on its own and so admitted rows the reader cannot emit:
 * `{roomRole: null, accessSource: 'assignment'}` and
 * `{roomRole: 'manager', accessSource: 'global_role'}`. Fastify would have serialized
 * both, and because this surface EXPLAINS access from these fields, each is a false
 * statement about why a room can be opened rather than untidy data.
 */
const ROOM = Type.Union([ASSIGNED_ROOM, ROLE_DERIVED_ROOM]);

/* A numeric string, because a querystring carries text and `coerceTypes` is
   deliberately off for every route in this application. */
const LIMIT = Type.Optional(Type.String({ pattern: '^(?:[1-9]|[1-9][0-9]|100)$' }));

export const schema = {
  /*
   * BOTH CURSOR COMPONENTS OR NEITHER, decided by the schema.
   *
   * A union of "no cursor" and "a whole cursor" rather than two independent optional
   * fields, so half a key is refused at the validation boundary and answered with the
   * designed 400. The handler used to throw a bare `Error` for this, which the failure
   * mapping does not recognize as a refusal: a client that sent half a cursor got HTTP
   * 500, indistinguishable from a crashed request, and the server logged a fault for a
   * malformed request it had correctly rejected.
   */
  querystring: Type.Union([
    Type.Object({ limit: LIMIT }, { additionalProperties: false }),
    Type.Object(
      {
        limit: LIMIT,
        /* Echoed from a previous response's `nextCursor`, unmodified. */
        afterTitle: Type.String({ minLength: 1, maxLength: 200 }),
        afterRoomId: Type.String(),
      },
      { additionalProperties: false },
    ),
  ]),
  response: {
    200: Type.Object(
      {
        rooms: Type.Array(ROOM, { maxItems: MAX_ROOM_PAGE_LIMIT }),
        /* Absent on the last page, so a client cannot mistake "no more" for
           "unknown" and cannot request a page that cannot exist. */
        nextCursor: Type.Optional(ROOM_CURSOR),
      },
      { additionalProperties: false },
    ),
  },
};

interface Query {
  readonly limit?: string;
  readonly afterTitle?: string;
  readonly afterRoomId?: string;
}

export interface RoomListResponse {
  readonly rooms: readonly MemberRoom[];
  readonly nextCursor?: MemberRoomCursor;
}

export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (request: FastifyRequest): Promise<RoomListResponse> => {
    const query = request.query as Query;
    /* Both components or neither, already guaranteed by the querystring union above:
       half a key would resume at a position that exists in neither ordering and would
       skip or repeat rooms sharing a title. The narrowing here is the type-level
       consequence of that, not a second rule that could drift from it. */
    const after =
      query.afterTitle === undefined || query.afterRoomId === undefined
        ? null
        : { title: query.afterTitle, roomId: query.afterRoomId };
    const page = await readMemberRooms({
      pool: runtime.pool,
      identity,
      after,
      limit: Number(query.limit ?? String(ROOM_PAGE_LIMIT)),
    });
    return {
      rooms: page.rooms,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  };
}
export function handler(): never {
  throw new Error('room list route runtime not initialized');
}
