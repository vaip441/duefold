import type {
  MemberRoom,
  MemberSubject,
  ProvisionedMember,
  RoomAssignment,
  RoomRole,
} from '../api/client.ts';

export type DraftRole = RoomRole | 'none';
export type AssignmentDraft = Readonly<Record<string, DraftRole>>;

export interface AssignmentBatch {
  readonly assign: readonly RoomAssignment[];
  readonly revoke: readonly string[];
}

export function heldRoles(subject: ProvisionedMember | null): AssignmentDraft {
  const held: Record<string, DraftRole> = {};
  for (const assignment of subject?.assignments ?? [])
    held[assignment.roomId] = assignment.roomRole;
  return held;
}

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
 * The most entries one batch may carry, counting assignments and revocations TOGETHER.
 *
 * `apply_room_assignments` bounds the sum, so this is that same number and not a
 * per-array limit. A draft of 60 staffings and 60 removals is 120 entries: within any
 * per-array bound, over the real one, and previously discovered only when the server
 * answered 400.
 */
export const MAX_BATCH_ENTRIES = 100;

export function batchWithinLimit(batch: AssignmentBatch): boolean {
  return batch.assign.length + batch.revoke.length <= MAX_BATCH_ENTRIES;
}

export function confirmationMatches(typed: string, phrase: string | null): boolean {
  return phrase !== null && typed === phrase;
}

export function isRoomAssignable(subject: MemberSubject): subject is ProvisionedMember {
  return subject.subjectKind === 'member' && subject.capabilities.assignRooms;
}

export function isTransferTarget(subject: MemberSubject): subject is ProvisionedMember {
  return subject.subjectKind === 'member' && subject.capabilities.transfer;
}
