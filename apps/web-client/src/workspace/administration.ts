/**
 * Pure logic for the member administration surface.
 *
 * Extracted from the components so it can be tested without a DOM, and so there is
 * one definition of each rule rather than one per surface that could drift.
 *
 * Nothing here decides access. It describes what the server reported and what the
 * member has asked for; every refusal is the server's.
 */

import type {
  MemberRoom,
  MemberSubject,
  ProvisionedMember,
  RoomAssignment,
  RoomRole,
} from '../api/client.ts';

/** One room's draft value: a role, or not staffed at all. */
export type DraftRole = RoomRole | 'none';
export type AssignmentDraft = Readonly<Record<string, DraftRole>>;

export interface AssignmentBatch {
  readonly assign: readonly RoomAssignment[];
  readonly revoke: readonly string[];
}

/**
 * The roles a member currently holds, keyed by room.
 *
 * Takes a PROVISIONED member, not any subject: only a member has assignments at all.
 * An invitation has no member row, so there is nothing a room privilege could reference,
 * and accepting one here would have invited the reading that it holds no rooms *yet*.
 */
export function heldRoles(subject: ProvisionedMember | null): AssignmentDraft {
  const held: Record<string, DraftRole> = {};
  for (const assignment of subject?.assignments ?? [])
    held[assignment.roomId] = assignment.roomRole;
  return held;
}

/**
 * Diffs a draft against what the member holds.
 *
 * Only rooms the draft actually changes appear in the batch. A batch that repeated
 * unchanged rows would still fire `room_assignment_privilege_session_revoke` and sign
 * the member out for nothing.
 *
 * Rooms outside `rooms` are deliberately untouched rather than revoked. A member can
 * hold an assignment to a room this administrator's register does not list, and
 * treating "not in my list" as "remove it" would silently strip access the surface
 * never showed.
 */
export function assignmentBatch(input: {
  readonly rooms: readonly MemberRoom[];
  readonly held: AssignmentDraft;
  readonly draft: AssignmentDraft;
}): AssignmentBatch {
  const assign: RoomAssignment[] = [];
  const revoke: string[] = [];
  for (const room of input.rooms) {
    const next = input.draft[room.roomId] ?? 'none';
    const current = input.held[room.roomId] ?? 'none';
    if (next === current) continue;
    if (next === 'none') revoke.push(room.roomId);
    else assign.push({ roomId: room.roomId, roomRole: next });
  }
  return { assign, revoke };
}

export function batchChangesSomething(batch: AssignmentBatch): boolean {
  return batch.assign.length > 0 || batch.revoke.length > 0;
}

/**
 * Whether a typed confirmation matches the server's phrase EXACTLY.
 *
 * No trimming, no case folding, no normalization of any kind. Trimming looked like
 * forgiving a typing artefact, but it made the client accept a string the server's own
 * check would then be asked about a DIFFERENT string: the dialog submitted the trimmed
 * value, so the near miss was silently corrected instead of surfacing. A deliberate
 * human gate that quietly repairs its own input is not a gate, and the caller submits
 * the untouched value so the authoritative comparison sees exactly what was typed.
 */
export function confirmationMatches(typed: string, phrase: string | null): boolean {
  return phrase !== null && typed === phrase;
}

/**
 * Whether a reported change failure belongs to THIS member's assignment dialog.
 *
 * `changeFailure` is shared by role, state, invitation-revocation and assignment, so a
 * dialog that showed it unconditionally adopted whatever was reported last: after any
 * failed row mutation, opening room assignment — for that member or a different one —
 * presented the unrelated error as though the draft on screen had been rejected.
 *
 * Matching the origin keeps a genuine assignment failure visible across a retry within the
 * same dialog, which is the behaviour the draft-preserving lifecycle depends on, while
 * refusing to adopt anyone else's. It is a pure rule so it can be tested without a portal.
 */
export function assignmentFailureBelongsTo(
  origin: { readonly operation: string; readonly subjectId: string } | null,
  subjectId: string | null,
): boolean {
  return (
    origin !== null &&
    origin.operation === 'assignment' &&
    subjectId !== null &&
    origin.subjectId === subjectId
  );
}

/**
 * Whether a subject may be staffed into rooms individually.
 *
 * Only an active plain Member. An Owner or Admin already holds Room Manager
 * authority in every room, so an assignment row for them would advertise a narrower
 * role than the authority they keep; an invitation names someone who has never signed
 * in and holds nothing; a disabled member cannot sign in at all.
 *
 * This is presentation, not authorization: the server refuses the same targets, and
 * hiding the control only avoids offering an action that would be rejected.
 */
export function isRoomAssignable(subject: MemberSubject): subject is ProvisionedMember {
  return (
    subject.subjectKind === 'member' &&
    subject.globalRole === 'member' &&
    subject.state === 'active'
  );
}

/**
 * Whether a subject's role and access may be administered from a row.
 *
 * The Owner is excluded: ownership moves only through the audited transfer, and the
 * Owner cannot be disabled, so both controls would present actions the server
 * refuses. An invitation is excluded because neither control can act on someone who
 * has never signed in.
 */
export function isAdministrable(subject: MemberSubject): subject is ProvisionedMember {
  return subject.subjectKind === 'member' && subject.globalRole !== 'owner';
}
