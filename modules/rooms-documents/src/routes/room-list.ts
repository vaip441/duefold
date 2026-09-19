import { Type } from '@sinclair/typebox';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import { readMemberRooms, type MemberRoom } from '../workspace-reads.ts';

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
 */
export const schema = {
  response: {
    200: Type.Object(
      {
        rooms: Type.Array(
          Type.Object(
            {
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
              roomRole: Type.Union([
                Type.Literal('manager'),
                Type.Literal('contributor'),
                Type.Null(),
              ]),
              accessSource: Type.Union([
                Type.Literal('assignment'),
                Type.Literal('global_role'),
              ]),
              canPublish: Type.Boolean(),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
};

export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (): Promise<{ readonly rooms: readonly MemberRoom[] }> => {
    const rooms = await readMemberRooms({ pool: runtime.pool, identity });
    return { rooms };
  };
}
export function handler(): never {
  throw new Error('room list route runtime not initialized');
}
