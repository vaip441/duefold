import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../authorization.ts';
import {
  applyRoomAssignments,
  dryRunOwnershipTransfer,
  inviteMember,
  revokeMemberInvitation,
  setMemberGlobalRole,
  setMemberState,
  transferOwnership,
  MAX_MEMBER_ASSIGNMENTS,
  type AppliedAssignments,
  type AssignableGlobalRole,
  type MemberState,
  type OwnershipTransferImpact,
  type RoomAssignment,
} from '../administration.ts';
import { protectedErrorResponses } from './error-envelope.ts';

const ID = Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' });
const ROLE = Type.Union([Type.Literal('admin'), Type.Literal('member')]);
const ROOM_ROLE = Type.Union([Type.Literal('manager'), Type.Literal('contributor')]);
const REVISION = Type.Integer({ minimum: 1 });
const CONFIRMATION = Type.String({ minLength: 1, maxLength: 200 });
const NO_EXTRAS = { additionalProperties: false } as const;
const MAX_BATCH_ENTRIES = 100;
const MAX_PREVIEW_ROOMS = 100;

const ASSIGNMENT = Type.Object({ roomId: ID, roomRole: ROOM_ROLE }, NO_EXTRAS);

export const schema = {
  body: Type.Union([
    Type.Object(
      {
        action: Type.Literal('invite'),
        email: Type.String({ minLength: 3, maxLength: 320 }),
        intendedRole: ROLE,
      },
      NO_EXTRAS,
    ),
    Type.Object({ action: Type.Literal('revoke-invitation'), invitationId: ID }, NO_EXTRAS),
    Type.Object(
      {
        action: Type.Literal('set-role'),
        memberId: ID,
        role: ROLE,
        expectedRevision: REVISION,
      },
      NO_EXTRAS,
    ),
    Type.Object(
      {
        action: Type.Literal('set-state'),
        memberId: ID,
        state: Type.Union([Type.Literal('active'), Type.Literal('disabled')]),
        expectedRevision: REVISION,
      },
      NO_EXTRAS,
    ),
    Type.Object({ action: Type.Literal('transfer-dry-run'), memberId: ID }, NO_EXTRAS),
    Type.Object(
      {
        action: Type.Literal('transfer-apply'),
        memberId: ID,
        previewId: ID,
        expectedRevision: REVISION,
        confirmation: CONFIRMATION,
      },
      NO_EXTRAS,
    ),
    Type.Object(
      {
        action: Type.Literal('assign-rooms'),
        memberId: ID,
        /*
         * `maxItems` bounds EACH array, but `apply_room_assignments` bounds their SUM, so
         * these two numbers cannot both be the batch limit. With both at 100, a 60-assign
         * and 60-revoke batch passed the schema and was then refused by SQL as too large:
         * a 400 the client could have been told about before sending, and a bound the
         * route appeared to enforce while enforcing something else.
         *
         * Each array is bounded by the whole batch limit, because either may legitimately
         * use all of it. The sum stays the authoritative rule and stays in SQL, where the
         * function that acts on the batch can enforce it; this schema only refuses the
         * arrays that could not satisfy it under any split.
         */
        assign: Type.Array(ASSIGNMENT, { maxItems: MAX_BATCH_ENTRIES }),
        revoke: Type.Array(ID, { maxItems: MAX_BATCH_ENTRIES }),
      },
      NO_EXTRAS,
    ),
  ]),
  response: {
    200: Type.Union([
      Type.Object({ memberId: ID, revision: REVISION }, NO_EXTRAS),
      Type.Object(
        {
          impact: Type.Object(
            {
              previewId: ID,
              targetEmailDisplay: Type.String({ minLength: 3, maxLength: 320 }),
              confirmation: Type.String({ minLength: 1, maxLength: 200 }),
              message: Type.String({ minLength: 1 }),
              expectedRevision: REVISION,
              revokedAssignmentCount: Type.Integer({
                minimum: 0,
                maximum: MAX_MEMBER_ASSIGNMENTS,
              }),
              revokedAssignments: Type.Array(
                Type.Object(
                  {
                    roomId: ID,
                    roomTitle: Type.String({ minLength: 1, maxLength: 200 }),
                    roomRole: ROOM_ROLE,
                  },
                  NO_EXTRAS,
                ),
                { maxItems: MAX_PREVIEW_ROOMS },
              ),
              revokedAssignmentsTruncated: Type.Boolean(),
            },
            NO_EXTRAS,
          ),
        },
        NO_EXTRAS,
      ),
      Type.Object(
        { transferred: Type.Literal(true), sessionEnded: Type.Literal(true) },
        NO_EXTRAS,
      ),
      Type.Object(
        {
          memberId: ID,
          changed: Type.Integer({ minimum: 0 }),
          assignments: Type.Array(ASSIGNMENT, { maxItems: MAX_MEMBER_ASSIGNMENTS }),
        },
        NO_EXTRAS,
      ),
    ]),
    201: Type.Object(
      {
        invitationId: ID,
        intendedRole: ROLE,
        expiresAt: Type.String({ format: 'date-time' }),
      },
      NO_EXTRAS,
    ),
    204: Type.Null(),
    ...protectedErrorResponses(),
  },
};

type Body =
  | {
      readonly action: 'invite';
      readonly email: string;
      readonly intendedRole: AssignableGlobalRole;
    }
  | { readonly action: 'revoke-invitation'; readonly invitationId: string }
  | {
      readonly action: 'set-role';
      readonly memberId: string;
      readonly role: AssignableGlobalRole;
      readonly expectedRevision: number;
    }
  | {
      readonly action: 'set-state';
      readonly memberId: string;
      readonly state: MemberState;
      readonly expectedRevision: number;
    }
  | { readonly action: 'transfer-dry-run'; readonly memberId: string }
  | {
      readonly action: 'transfer-apply';
      readonly memberId: string;
      readonly previewId: string;
      readonly expectedRevision: number;
      readonly confirmation: string;
    }
  | {
      readonly action: 'assign-rooms';
      readonly memberId: string;
      readonly assign: readonly RoomAssignment[];
      readonly revoke: readonly string[];
    };

export type MemberActionResponse =
  | {
      readonly invitationId: string;
      readonly intendedRole: AssignableGlobalRole;
      readonly expiresAt: string;
    }
  | null
  | { readonly memberId: string; readonly revision: number }
  | { readonly impact: OwnershipTransferImpact }
  | { readonly transferred: true; readonly sessionEnded: true }
  | AppliedAssignments;

export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<MemberActionResponse> => {
    const body = request.body as Body;
    switch (body.action) {
      case 'invite': {
        const invited = await inviteMember({
          pool: runtime.pool,
          identity,
          email: body.email,
          intendedRole: body.intendedRole,
        });
        reply.code(201);
        return {
          invitationId: invited.invitationId,
          intendedRole: invited.intendedRole,
          expiresAt: invited.expiresAt.toISOString(),
        };
      }
      case 'revoke-invitation': {
        await revokeMemberInvitation({
          pool: runtime.pool,
          identity,
          invitationId: body.invitationId,
        });
        reply.code(204);
        return null;
      }
      case 'set-role': {
        const changed = await setMemberGlobalRole({
          pool: runtime.pool,
          identity,
          memberId: body.memberId,
          role: body.role,
          expectedRevision: body.expectedRevision,
        });
        return { memberId: body.memberId, revision: changed.revision };
      }
      case 'set-state': {
        const changed = await setMemberState({
          pool: runtime.pool,
          identity,
          memberId: body.memberId,
          state: body.state,
          expectedRevision: body.expectedRevision,
        });
        return { memberId: body.memberId, revision: changed.revision };
      }
      case 'transfer-dry-run': {
        const impact = await dryRunOwnershipTransfer({
          pool: runtime.pool,
          identity,
          memberId: body.memberId,
        });
        return { impact };
      }
      case 'transfer-apply': {
        await transferOwnership({
          pool: runtime.pool,
          identity,
          memberId: body.memberId,
          expectedRevision: body.expectedRevision,
          previewId: body.previewId,
          confirmation: body.confirmation,
        });
        return { transferred: true, sessionEnded: true };
      }
      case 'assign-rooms':
        return applyRoomAssignments({
          pool: runtime.pool,
          identity,
          memberId: body.memberId,
          assign: body.assign,
          revoke: body.revoke,
        });
      default: {
        const exhaustive: never = body;
        return exhaustive;
      }
    }
  };
}
export function handler(): never {
  throw new Error('member action route runtime not initialized');
}
