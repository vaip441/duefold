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

/**
 * Organization administration actions.
 *
 * The route is `audience: 'member'` and contains no role branch: every function
 * it calls authorizes the actor in PostgreSQL and audits itself in the same
 * transaction (§15.1, invariant 4). A check here would be advisory and could drift
 * from the authoritative one, and a denial assembled here could not stay uniform.
 *
 * Ownership transfer is the high-consequence action (§9.4): `transfer-dry-run`
 * issues a server-recorded preview, and `transfer-apply` must present that
 * preview's id. The function consumes it once and refuses without it, so a client
 * that skipped the preview is refused by evidence rather than by a guess about a
 * constant phrase. Freshness is judged from the session-bound authentication
 * instant inside the same function.
 *
 * The preview also NAMES the successor's assignments the promotion will revoke, and
 * apply is bound to that exact set: the preview records a digest of it and
 * `transfer_ownership` re-checks the digest under the target's row lock. A privilege
 * revocation the Owner was never shown is not something a confirmation phrase can
 * consent to.
 *
 * `transfer-apply` succeeds on a session the same transaction revoked, because
 * `member_privilege_session_revoke` ends the outgoing Owner's sessions. The
 * response says so explicitly, so the client can present a completed transfer
 * rather than reading the next request's 401 as a failure.
 *
 * Room assignment takes a batch for one member rather than a room, because
 * `room_assignment_privilege_session_revoke` revokes all of that member's sessions
 * on every row change; one transaction is one sign-out. The response carries the
 * member's complete resulting assignment set, so the surface never has to infer
 * access from a count.
 */
const ID = Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' });
const ROLE = Type.Union([Type.Literal('admin'), Type.Literal('member')]);
const ROOM_ROLE = Type.Union([Type.Literal('manager'), Type.Literal('contributor')]);
const REVISION = Type.Integer({ minimum: 1 });
const CONFIRMATION = Type.String({ minLength: 1, maxLength: 200 });
const NO_EXTRAS = { additionalProperties: false } as const;
/** One batch per member; the same bound `apply_room_assignments` enforces. */
const MAX_BATCH_ENTRIES = 100;
/**
 * Rooms the ownership preview NAMES, as opposed to counts.
 *
 * The count is exact and unbounded-in-value but bounded by
 * `MAX_MEMBER_ASSIGNMENTS`; the named list also carries titles, so it is capped
 * lower and `revokedAssignmentsTruncated` states when the cap applied. A list that
 * ran short without saying so would understate a privilege revocation the Owner is
 * being asked to approve. The member list carries any one member's complete set, so
 * the remainder is reachable there.
 */
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
        /* The preview the dry run issued. Required, so apply cannot proceed on the
         * publicly documented phrase alone. */
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
        assign: Type.Array(ASSIGNMENT, { maxItems: MAX_BATCH_ENTRIES }),
        revoke: Type.Array(ID, { maxItems: MAX_BATCH_ENTRIES }),
      },
      NO_EXTRAS,
    ),
  ]),
  response: {
    200: Type.Union([
      /*
       * Each outcome is its own exact shape rather than one object of optional
       * fields, so a client cannot read a response that omitted the part it
       * depends on as though the server had answered it. Every field a caller
       * acts on is REQUIRED here.
       */
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
              /* The privilege loss the promotion causes. §4.2 gives the Owner
               * standing Room Manager authority everywhere, so the successor's
               * explicit assignments are superseded; a preview that described only
               * the role change asked the Owner to approve a revocation it never
               * mentioned. REQUIRED, all three: an absent count would read as "no
               * rooms affected", and an omitted truncation flag would let a short
               * list read as the whole impact. */
              revokedAssignmentCount: Type.Integer({
                minimum: 0,
                maximum: MAX_MEMBER_ASSIGNMENTS,
              }),
              revokedAssignments: Type.Array(
                Type.Object(
                  {
                    roomId: ID,
                    /* Disclosed because this preview is Owner-only and the Owner
                     * already holds Room Manager authority in every room, so no room
                     * named here is one they could not open. */
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
          /* The member's complete resulting active set. Bounded, because
           * "complete" is only honest if it cannot grow without limit: rooms have no
           * installation cap, so apply_room_assignments refuses a batch that would
           * take one member past MAX_MEMBER_ASSIGNMENTS rather than returning a
           * truncated set the surface would read as complete. */
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
        /* The transfer revoked this session inside its own transaction. Saying so
         * here is the difference between a completed high-consequence change and
         * an unexplained sign-out on the next request. */
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
        /* Exhaustive: a new action cannot fall through to a permissive default. */
        const exhaustive: never = body;
        return exhaustive;
      }
    }
  };
}
export function handler(): never {
  throw new Error('member action route runtime not initialized');
}
