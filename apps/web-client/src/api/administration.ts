import {
  ApiError,
  failureForStatus,
  isRecord,
  json,
  request,
  requireNumber,
  requireString,
  serverErrorCode,
} from './transport.ts';

export type GlobalRole = 'owner' | 'admin' | 'member';
export type AssignableGlobalRole = 'admin' | 'member';
export type MemberState = 'active' | 'disabled';
export type RoomRole = 'manager' | 'contributor';

export interface RoomAssignment {
  readonly roomId: string;
  readonly roomRole: RoomRole;
}

export type MemberSubject = ProvisionedMember | PendingInvitation;

interface SubjectIdentity {
  readonly subjectId: string;
  readonly emailDisplay: string;
  readonly revision: number;
  readonly createdAt: string;
}

export interface SubjectCapabilities {
  readonly setRole: boolean;
  readonly setState: boolean;
  readonly assignRooms: boolean;
  readonly transfer: boolean;
}

export interface ProvisionedMember extends SubjectIdentity {
  readonly subjectKind: 'member';
  readonly globalRole: GlobalRole;
  readonly state: MemberState;
  readonly assignments: readonly RoomAssignment[];
  readonly capabilities: SubjectCapabilities;
}

export interface PendingInvitation extends SubjectIdentity {
  readonly subjectKind: 'invitation';
  readonly state: 'pending';
  readonly intendedRole: AssignableGlobalRole;
}

export interface MemberPageCursor {
  readonly createdAt: string;
  readonly subjectId: string;
}

export interface MemberPage {
  readonly subjects: readonly MemberSubject[];
  readonly nextCursor: MemberPageCursor | null;
}

export interface RevokedAssignment {
  readonly roomId: string;
  readonly roomTitle: string;
  readonly roomRole: RoomRole;
}

export interface OwnershipTransferImpact {
  readonly previewId: string;
  readonly targetEmailDisplay: string;
  readonly confirmation: string;
  readonly message: string;
  readonly expectedRevision: number;
  readonly revokedAssignmentCount: number;
  readonly revokedAssignments: readonly RevokedAssignment[];
  readonly revokedAssignmentsTruncated: boolean;
}

export interface InvitedMember {
  readonly invitationId: string;
  readonly intendedRole: AssignableGlobalRole;
  readonly expiresAt: string;
}

export interface AppliedAssignments {
  readonly memberId: string;
  readonly changed: number;
  readonly assignments: readonly RoomAssignment[];
}

const GLOBAL_ROLES: readonly GlobalRole[] = ['owner', 'admin', 'member'];
const MEMBER_STATES: readonly MemberState[] = ['active', 'disabled'];
const ASSIGNABLE_ROLES: readonly AssignableGlobalRole[] = ['admin', 'member'];
const ROOM_ROLES: readonly RoomRole[] = ['manager', 'contributor'];

function oneOf<T extends string>(allowed: readonly T[], value: unknown): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value))
    throw new ApiError('unavailable');
  return value as T;
}

function parseAssignment(value: unknown): RoomAssignment {
  if (!isRecord(value)) throw new ApiError('unavailable');
  return {
    roomId: requireString(value, 'roomId'),
    roomRole: oneOf(ROOM_ROLES, value['roomRole']),
  };
}

function parseAssignments(value: unknown): readonly RoomAssignment[] {
  if (!Array.isArray(value)) throw new ApiError('unavailable');
  return value.map(parseAssignment);
}

function parseIdentity(value: Readonly<Record<string, unknown>>): SubjectIdentity {
  return {
    subjectId: requireString(value, 'subjectId'),
    emailDisplay: requireString(value, 'emailDisplay'),
    revision: requireNumber(value, 'revision'),
    createdAt: requireString(value, 'createdAt'),
  };
}

function parseCapabilities(value: unknown): SubjectCapabilities {
  if (!isRecord(value)) throw new ApiError('unavailable');
  const flag = (key: keyof SubjectCapabilities): boolean => {
    const present = value[key];
    if (typeof present !== 'boolean') throw new ApiError('unavailable');
    return present;
  };
  return {
    setRole: flag('setRole'),
    setState: flag('setState'),
    assignRooms: flag('assignRooms'),
    transfer: flag('transfer'),
  };
}

function parseSubject(value: unknown): MemberSubject {
  if (!isRecord(value)) throw new ApiError('unavailable');
  const kind = value['subjectKind'];
  if (kind === 'member') {
    return {
      subjectKind: 'member',
      ...parseIdentity(value),
      globalRole: oneOf(GLOBAL_ROLES, value['globalRole']),
      state: oneOf(MEMBER_STATES, value['state']),
      assignments: parseAssignments(value['assignments']),
      capabilities: parseCapabilities(value['capabilities']),
    };
  }
  if (kind === 'invitation') {
    if (value['state'] !== 'pending') throw new ApiError('unavailable');
    const intendedRole = oneOf(ASSIGNABLE_ROLES, value['globalRole']);
    if ('assignments' in value) throw new ApiError('unavailable');
    return {
      subjectKind: 'invitation',
      ...parseIdentity(value),
      state: 'pending',
      intendedRole,
    };
  }
  throw new ApiError('unavailable');
}

function parseCursor(value: unknown): MemberPageCursor | null {
  if (value === undefined) return null;
  if (!isRecord(value)) throw new ApiError('unavailable');
  return {
    createdAt: requireString(value, 'createdAt'),
    subjectId: requireString(value, 'subjectId'),
  };
}

export async function loadMembers(input?: {
  readonly after?: MemberPageCursor | null;
  readonly signal?: AbortSignal;
}): Promise<MemberPage> {
  const after = input?.after ?? null;
  const suffix =
    after === null
      ? ''
      : `?afterCreatedAt=${encodeURIComponent(after.createdAt)}` +
        `&afterSubjectId=${encodeURIComponent(after.subjectId)}`;
  const payload = await json({
    method: 'GET',
    path: `/api/members${suffix}`,
    ...(input?.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  const subjects = payload['subjects'];
  if (!Array.isArray(subjects)) throw new ApiError('unavailable');
  return {
    subjects: subjects.map(parseSubject),
    nextCursor: parseCursor(payload['nextCursor']),
  };
}

export async function inviteMember(input: {
  readonly email: string;
  readonly intendedRole: AssignableGlobalRole;
}): Promise<InvitedMember> {
  const payload = await json({
    method: 'POST',
    path: '/api/members/actions',
    body: { action: 'invite', ...input },
  });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  return {
    invitationId: requireString(payload, 'invitationId'),
    intendedRole: oneOf(['admin', 'member'] as const, payload['intendedRole']),
    expiresAt: requireString(payload, 'expiresAt'),
  };
}

export async function revokeMemberInvitation(invitationId: string): Promise<void> {
  const response = await request({
    method: 'POST',
    path: '/api/members/actions',
    body: { action: 'revoke-invitation', invitationId },
  });
  if (!response.ok)
    throw new ApiError(failureForStatus(response.status, await serverErrorCode(response)));
}

export async function setMemberRole(input: {
  readonly memberId: string;
  readonly role: AssignableGlobalRole;
  readonly expectedRevision: number;
}): Promise<{ readonly memberId: string; readonly revision: number }> {
  return parseRevision(await action({ action: 'set-role', ...input }));
}

export async function setMemberState(input: {
  readonly memberId: string;
  readonly state: MemberState;
  readonly expectedRevision: number;
}): Promise<{ readonly memberId: string; readonly revision: number }> {
  return parseRevision(await action({ action: 'set-state', ...input }));
}

export async function applyRoomAssignments(input: {
  readonly memberId: string;
  readonly assign: readonly RoomAssignment[];
  readonly revoke: readonly string[];
}): Promise<AppliedAssignments> {
  const payload = await action({ action: 'assign-rooms', ...input });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  return {
    memberId: requireString(payload, 'memberId'),
    changed: requireNumber(payload, 'changed'),
    assignments: parseAssignments(payload['assignments']),
  };
}

export async function dryRunOwnershipTransfer(
  memberId: string,
): Promise<OwnershipTransferImpact> {
  const payload = await action({ action: 'transfer-dry-run', memberId });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  const impact = payload['impact'];
  if (!isRecord(impact)) throw new ApiError('unavailable');
  const rooms = impact['revokedAssignments'];
  if (!Array.isArray(rooms)) throw new ApiError('unavailable');
  const truncated = impact['revokedAssignmentsTruncated'];
  if (typeof truncated !== 'boolean') throw new ApiError('unavailable');
  return {
    previewId: requireString(impact, 'previewId'),
    targetEmailDisplay: requireString(impact, 'targetEmailDisplay'),
    confirmation: requireString(impact, 'confirmation'),
    message: requireString(impact, 'message'),
    expectedRevision: requireNumber(impact, 'expectedRevision'),
    revokedAssignmentCount: requireNumber(impact, 'revokedAssignmentCount'),
    revokedAssignments: rooms.map((entry) => {
      if (!isRecord(entry)) throw new ApiError('unavailable');
      return {
        roomId: requireString(entry, 'roomId'),
        roomTitle: requireString(entry, 'roomTitle'),
        roomRole: oneOf(ROOM_ROLES, entry['roomRole']),
      };
    }),
    revokedAssignmentsTruncated: truncated,
  };
}

export async function applyOwnershipTransfer(input: {
  readonly memberId: string;
  readonly previewId: string;
  readonly expectedRevision: number;
  readonly confirmation: string;
}): Promise<void> {
  const payload = await action({ action: 'transfer-apply', ...input });
  if (!isRecord(payload) || payload['transferred'] !== true || payload['sessionEnded'] !== true)
    throw new ApiError('unavailable');
}

async function action(body: Readonly<Record<string, unknown>>): Promise<unknown> {
  return json({ method: 'POST', path: '/api/members/actions', body });
}

function parseRevision(payload: unknown): {
  readonly memberId: string;
  readonly revision: number;
} {
  if (!isRecord(payload)) throw new ApiError('unavailable');
  return {
    memberId: requireString(payload, 'memberId'),
    revision: requireNumber(payload, 'revision'),
  };
}
