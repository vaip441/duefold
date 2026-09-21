/**
 * Organization administration: members, invitations, roles, states, assignments,
 * and ownership transfer.
 *
 * Every field is validated off the wire rather than cast, for one reason that is
 * not tidiness: this surface reports who inside the organization can reach which
 * rooms, so a value the server did not actually send must not be rendered as
 * though it had been. A role or state this process does not recognize is a
 * failure, not a row — substituting a guess would show access the server never
 * described.
 *
 * Two contracts here are load-bearing:
 *
 * 1. THE PAGE IS NEVER PARTIAL PER SUBJECT. Each subject carries its complete
 *    active assignment set; the server bounds a page by returning fewer SUBJECTS.
 *    A page may therefore be shorter than the limit and still continue, so
 *    completeness is `nextCursor` and nothing else. The caller must follow the
 *    cursor rather than stop when a page looks short.
 * 2. THE CURSOR IS ECHOED UNMODIFIED. `nextCursor.createdAt` is PostgreSQL's exact
 *    timestamp text. Parsing and re-serializing it would truncate microseconds to
 *    milliseconds, move the cursor earlier than the row it came from, and in
 *    descending order skip every subject tied at that microsecond. It is a string
 *    here and stays one.
 */

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

/**
 * One row of the member list, as a discriminated union.
 *
 * `subjectKind` is load-bearing rather than cosmetic, and the two kinds do not share
 * a shape. `member.state` admits `'invited'`, but acceptance inserts `'active'`
 * directly and no transition leads into `'invited'`, so an invited person exists ONLY
 * as an invitation row. A surface that rendered the two alike would claim someone has
 * access before they have ever signed in.
 *
 * A FLAT RECORD WOULD ADMIT RECORDS THAT CANNOT EXIST. Validating each field on its
 * own accepted an `invitation` that was `active`, held the `owner` role, and carried
 * room assignments, and a `member` that was `pending` — every one a false statement
 * about access, and each one able to put controls on a row that should not have them.
 * Splitting the union makes those combinations unrepresentable rather than merely
 * unexpected, so the compiler refuses them and the parser cannot pass one through.
 */
export type MemberSubject = ProvisionedMember | PendingInvitation;

interface SubjectIdentity {
  readonly subjectId: string;
  readonly emailDisplay: string;
  readonly revision: number;
  readonly createdAt: string;
}

/** Someone who has signed in. Holds a real role, a real state, and real rooms. */
export interface ProvisionedMember extends SubjectIdentity {
  readonly subjectKind: 'member';
  readonly globalRole: GlobalRole;
  readonly state: MemberState;
  /** The member's COMPLETE active set. */
  readonly assignments: readonly RoomAssignment[];
}

/**
 * Someone invited who has never signed in.
 *
 * `state` is `'pending'` and nothing else, `intendedRole` is the role they WILL hold
 * rather than one they hold now, and there is no `assignments` field at all: an
 * invitation has no member row, so there is nothing a room assignment could reference.
 * An empty array would have invited the reading that they hold no rooms *yet*, which is
 * a statement about access that does not apply.
 */
export interface PendingInvitation extends SubjectIdentity {
  readonly subjectKind: 'invitation';
  readonly state: 'pending';
  readonly intendedRole: AssignableGlobalRole;
}

export interface MemberPageCursor {
  /** Server text, echoed unmodified. Not RFC 3339, and never reformatted. */
  readonly createdAt: string;
  readonly subjectId: string;
}

export interface MemberPage {
  readonly subjects: readonly MemberSubject[];
  /** Absent when the server proved this page is the last one. */
  readonly nextCursor: MemberPageCursor | null;
}

/** One room an ownership transfer would revoke from the successor. */
export interface RevokedAssignment {
  readonly roomId: string;
  readonly roomTitle: string;
  readonly roomRole: RoomRole;
}

/**
 * The server's ownership-transfer preview.
 *
 * `previewId` is the evidence the required dry run happened; apply presents it and
 * the server consumes it once. The confirmation phrase is a documented constant, so
 * the phrase alone proves only that the caller read the documentation.
 *
 * `revokedAssignment*` name the privilege loss the promotion causes: ownership
 * carries standing Room Manager authority everywhere, so the successor's explicit
 * assignments are superseded. The count is exact; the named list is capped and
 * `revokedAssignmentsTruncated` says when the cap applied, so a short list never
 * reads as the whole impact.
 */
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
  /** The member's complete resulting active set, not a count to interpret. */
  readonly assignments: readonly RoomAssignment[];
}

/**
 * The outcome of a completed ownership transfer.
 *
 * `session-ended` is a SUCCESS. The transfer revokes the outgoing Owner's sessions
 * inside its own transaction, so the response arrives on a session that no longer
 * exists. See `applyOwnershipTransfer`.
 */
export interface TransferOutcome {
  readonly outcome: 'transferred' | 'session-ended';
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

/**
 * Parses one subject, enforcing the invariants its kind implies.
 *
 * Each kind is read against its OWN rules rather than against a shared superset, so a
 * combination that cannot exist is refused instead of rendered. An invitation that
 * arrived `active`, as `owner`, or carrying assignments would each be a false statement
 * about access; a `member` that arrived `pending` would claim someone has a member row
 * before they have signed in. Any of them means this process and the server disagree
 * about the vocabulary, and guessing which half is right is exactly the substitution
 * that shows access the server never described.
 */
function parseSubject(value: unknown): MemberSubject {
  if (!isRecord(value)) throw new ApiError('unavailable');
  const kind = value['subjectKind'];
  if (kind === 'member') {
    /* A member's state is active or disabled. `'pending'` belongs to an invitation
       and reaching it here would mean an unreachable member state was serialized. */
    return {
      subjectKind: 'member',
      ...parseIdentity(value),
      globalRole: oneOf(GLOBAL_ROLES, value['globalRole']),
      state: oneOf(MEMBER_STATES, value['state']),
      assignments: parseAssignments(value['assignments']),
    };
  }
  if (kind === 'invitation') {
    /* Exactly `'pending'`: the reader returns only pending invitations, so any other
       state means the row is not what the contract says it is. */
    if (value['state'] !== 'pending') throw new ApiError('unavailable');
    /* An invitation names an assignable role. `owner` is unreachable — ownership moves
       only through the audited transfer — so an invitation claiming it would advertise
       an arrival the server cannot honour. */
    const intendedRole = oneOf(ASSIGNABLE_ROLES, value['globalRole']);
    /*
     * NO `assignments` PROPERTY AT ALL, empty included.
     *
     * The wire union closes the invitation object with `additionalProperties: false`, so
     * the server cannot send this field and a response carrying it did not come from a
     * contract this client agrees with. Tolerating an empty array and dropping it was
     * strictly worse than refusing: the two halves of one semantic union then disagreed
     * about what is representable, and the client repaired malformed state instead of
     * reporting it — exactly the silent substitution this parser exists to prevent.
     */
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
  /*
   * Percent-encoded explicitly rather than through `URLSearchParams`, which renders
   * a space as `+`. The cursor is PostgreSQL's timestamp text and contains a space,
   * and `+` only decodes back to one under form-urlencoded semantics. `%20` decodes
   * to a space either way, so the cursor survives regardless of how the query is
   * parsed — and a cursor that arrives altered resumes at the wrong instant and
   * silently skips subjects.
   *
   * Both components travel together or neither does. A partial cursor is a 400 the
   * server decides; sending half of one would be this process inventing a page.
   */
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
  /* 204 No Content, so there is no body to read; `json` would reject an empty
     one as unavailable and report a completed revocation as a failure. */
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

/**
 * Applies an ownership transfer.
 *
 * A 401 HERE, AND ONLY HERE, IS SUCCESS. The transfer revokes the acting Owner's
 * sessions inside its own transaction, so the response can arrive after the
 * session row is already gone and the browser sees 401 rather than the body. That
 * is the documented outcome of a completed transfer, so it resolves as
 * `session-ended` and the surface reports the transfer and the sign-out together.
 *
 * The mapping is confined to this one call on purpose. Treating 401 as success
 * anywhere else would turn an expired session into a false "it worked", so no
 * other call gets this treatment. A server that answers normally says
 * `sessionEnded: true` in the body, which is the same outcome by the ordinary path.
 */
export async function applyOwnershipTransfer(input: {
  readonly memberId: string;
  readonly previewId: string;
  readonly expectedRevision: number;
  readonly confirmation: string;
}): Promise<TransferOutcome> {
  try {
    const payload = await action({ action: 'transfer-apply', ...input });
    if (!isRecord(payload) || payload['transferred'] !== true)
      throw new ApiError('unavailable');
    return { outcome: payload['sessionEnded'] === true ? 'session-ended' : 'transferred' };
  } catch (error: unknown) {
    if (error instanceof ApiError && error.failure === 'unauthenticated')
      return { outcome: 'session-ended' };
    throw error;
  }
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
