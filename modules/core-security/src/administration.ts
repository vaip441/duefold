/**
 * Organization administration operations.
 *
 * Every function here is a thin call over a SECURITY DEFINER function that
 * authorizes the actor itself and writes its audit row in the same transaction.
 * This layer decides nothing: it does not read or branch on a global role, and it
 * never writes an audit row, because a security mutation and its evidence must
 * commit together inside PostgreSQL (§15.1). A role check here would be advisory
 * and could drift from the authoritative one.
 *
 * Migration 017 narrows the direct table privileges 001 had granted, so there is
 * now no path from this process to a room privilege or an invitation's intended
 * role except through these functions: `duefold_runtime` holds SELECT alone on
 * `room_assignment` and `member`, and nothing at all on `invitation`.
 */
import type { Pool } from 'pg';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import { normalizeEmail } from '@duefold/shared/email';
import type { GlobalRole, MemberIdentity, RoomRole } from './authorization.ts';

/** The two roles an invitation or a role change may name. Never `owner`. */
export type AssignableGlobalRole = Extract<GlobalRole, 'admin' | 'member'>;
export type MemberState = 'active' | 'disabled';

/**
 * A row of the member list, as a discriminated union.
 *
 * `subjectKind` is load-bearing and the two kinds do not share a shape.
 * `member.state` permits `'invited'`, but OIDC acceptance inserts `'active'`
 * directly, so an invited person exists only as an invitation row and never as a
 * member row. A surface that rendered the two alike would claim someone has access
 * before they have ever signed in.
 *
 * A FLAT RECORD MADE IMPOSSIBLE ROWS REPRESENTABLE: an invitation carrying `owner`,
 * an `active` invitation, a `pending` member, or an invitation with assignments would
 * each have type-checked and serialized, and each is a false statement about access.
 * The union removes them from the type, and the reader below refuses them from the
 * data rather than reshaping whichever half looked wrong.
 */
export type MemberSubject = ProvisionedMemberSubject | PendingInvitationSubject;

interface SubjectIdentity {
  readonly subjectId: string;
  readonly emailDisplay: string;
  readonly revision: number;
  readonly createdAt: Date;
}

/**
 * Someone who has signed in.
 *
 * `assignments` is that member's COMPLETE active set, never a prefix. The reader
 * bounds the page by dropping trailing subjects rather than by shortening any one
 * subject's rooms, so a short room list is always the member's whole access.
 */
export interface ProvisionedMemberSubject extends SubjectIdentity {
  readonly subjectKind: 'member';
  readonly globalRole: GlobalRole;
  readonly state: MemberState;
  readonly assignments: readonly RoomAssignment[];
}

/**
 * Someone invited who has never signed in.
 *
 * No `assignments` property at all: an invitation has no member row, so nothing could
 * hold an assignment against it, and an empty array would still have invited the reading
 * that they hold no rooms *yet*.
 *
 * `globalRole` is narrowed to the roles an invitation may NAME. It keeps the wire name it
 * has always had, but the type refuses `owner`, because ownership moves only through the
 * audited transfer and an invitation promising it would advertise an arrival the server
 * cannot honour. The browser renames it on receipt, where presenting it as a role held
 * rather than promised would be the actual mistake.
 */
export interface PendingInvitationSubject extends SubjectIdentity {
  readonly subjectKind: 'invitation';
  readonly state: 'pending';
  readonly globalRole: AssignableGlobalRole;
}
export interface RoomAssignment {
  readonly roomId: string;
  readonly roomRole: RoomRole;
}
export interface InvitedMember {
  readonly invitationId: string;
  readonly intendedRole: AssignableGlobalRole;
  readonly expiresAt: Date;
}
/**
 * One room an ownership transfer would revoke from the successor.
 *
 * The title is disclosed because the preview is Owner-only and §4.2 gives the Owner
 * Room Manager authority in every room, so no room named here is one the caller
 * could not already open.
 */
export interface RevokedAssignmentPreview {
  readonly roomId: string;
  readonly roomTitle: string;
  readonly roomRole: RoomRole;
}
/**
 * A server-issued ownership preview.
 *
 * `previewId` is the evidence that the required dry run happened. `transfer_ownership`
 * consumes it once and refuses without it, so the confirmation phrase is the human
 * gate while this is the machine one (§9.4). `expectedRevision` is the target's
 * revision at preview time; the Owner agreed to an impact described at that revision.
 *
 * `revokedAssignment*` name the privilege loss the promotion causes: ownership carries
 * standing Room Manager authority everywhere (§4.2), so the successor's explicit
 * assignments are superseded. A preview that described only the role change asked the
 * Owner to approve a revocation it never mentioned. The count is exact and the list is
 * bounded, with `revokedAssignmentsTruncated` saying so rather than letting a short
 * list read as the whole impact; the member list carries any one member's complete set.
 */
export interface OwnershipTransferImpact {
  readonly previewId: string;
  readonly targetEmailDisplay: string;
  readonly confirmation: string;
  readonly message: string;
  readonly expectedRevision: number;
  readonly revokedAssignmentCount: number;
  readonly revokedAssignments: readonly RevokedAssignmentPreview[];
  readonly revokedAssignmentsTruncated: boolean;
}
export interface AppliedAssignments {
  readonly memberId: string;
  readonly changed: number;
  readonly assignments: readonly RoomAssignment[];
}

/**
 * A keyset cursor over the member list.
 *
 * `createdAt` is the server's exact textual timestamp, echoed unmodified. It is a
 * string rather than a `Date` on purpose: PostgreSQL `timestamptz` holds
 * microseconds and a JavaScript `Date` holds milliseconds, so parsing and
 * re-serializing it would truncate the instant, move the cursor earlier than the row
 * it came from, and silently skip every subject tied at that microsecond.
 */
export interface MemberPageCursor {
  readonly createdAt: string;
  readonly subjectId: string;
}
export interface MemberPage {
  readonly subjects: readonly MemberSubject[];
  /** Absent when this page is provably the last one. */
  readonly nextCursor?: MemberPageCursor;
}

/** Members and pending invitations both grow, so a page is bounded (§23). */
export const MEMBER_PAGE_LIMIT = 50;
export const MAX_MEMBER_PAGE_LIMIT = 100;
/**
 * Active assignments one member may hold, enforced by `apply_room_assignments` and
 * used as `read_members`' per-page assignment budget.
 *
 * It is the same number in both places on purpose: because one member's complete set
 * always fits one page's budget, the reader can bound a page by dropping trailing
 * SUBJECTS and still promise a complete assignment set for every subject it returns.
 */
export const MAX_MEMBER_ASSIGNMENTS = 500;

interface MemberRow {
  readonly subject_kind: string;
  readonly subject_id: string;
  readonly email_display: string;
  readonly global_role: string;
  readonly state: string;
  readonly revision: number;
  readonly created_at: Date;
  /** Exact server text for the cursor; see `MemberPageCursor`. */
  readonly cursor_created_at: string;
  readonly assignments: readonly { readonly roomId: string; readonly roomRole: string }[];
  /** Whether further subjects remain, stated by the reader rather than inferred. */
  readonly continues: boolean;
}

const GLOBAL_ROLES: readonly GlobalRole[] = ['owner', 'admin', 'member'];
const MEMBER_STATES: readonly MemberState[] = ['active', 'disabled'];
const ASSIGNABLE_ROLES: readonly AssignableGlobalRole[] = ['admin', 'member'];
const ROOM_ROLES: readonly RoomRole[] = ['manager', 'contributor'];

/**
 * Values off the wire are validated rather than cast, in both directions. A value
 * PostgreSQL produced that this process does not recognize means the two disagree
 * about the vocabulary, and rendering it as though it were understood would show a
 * role or state the server did not mean. Fail closed instead.
 */
function oneOf<T extends string>(allowed: readonly T[], value: string, failure: string): T {
  if (!(allowed as readonly string[]).includes(value)) throw new Error(failure);
  return value as T;
}

function parseAssignments(row: MemberRow): readonly RoomAssignment[] {
  /*
   * The set is complete by construction, so a set larger than one member may legally
   * hold is a disagreement about the bound rather than a long list. Failing closed
   * keeps "complete" honest: the alternative is silently answering with a prefix.
   */
  if (row.assignments.length > MAX_MEMBER_ASSIGNMENTS)
    throw new Error('MEMBER_ASSIGNMENT_BOUND_EXCEEDED');
  return row.assignments.map((assignment) => ({
    roomId: assignment.roomId,
    roomRole: oneOf(ROOM_ROLES, assignment.roomRole, 'ROOM_ROLE_UNKNOWN'),
  }));
}

/**
 * Parses one reader row into the subject kind it claims to be.
 *
 * Each kind is read against its OWN rules. A row whose fields contradict its kind
 * means PostgreSQL and this process disagree about the vocabulary, and reshaping it
 * into whichever half looked plausible is exactly the substitution that reports access
 * the server never described. Fail closed instead.
 */
function parseSubjectRow(row: MemberRow): MemberSubject {
  const identity = {
    subjectId: row.subject_id,
    emailDisplay: row.email_display,
    revision: row.revision,
    createdAt: row.created_at,
  };
  if (row.subject_kind === 'member')
    return {
      subjectKind: 'member',
      ...identity,
      globalRole: oneOf(GLOBAL_ROLES, row.global_role, 'GLOBAL_ROLE_UNKNOWN'),
      /* `'pending'` belongs to an invitation, and `member.state='invited'` is
         unreachable, so either one here is an unreachable state serialized. */
      state: oneOf(MEMBER_STATES, row.state, 'MEMBER_STATE_UNKNOWN'),
      assignments: parseAssignments(row),
    };
  if (row.subject_kind === 'invitation') {
    /* The reader returns only pending invitations. */
    if (row.state !== 'pending') throw new Error('MEMBER_STATE_UNKNOWN');
    /* An invitation cannot name `owner`: ownership moves only through the audited
       transfer, so such a row would advertise an arrival that cannot happen. */
    const globalRole = oneOf(ASSIGNABLE_ROLES, row.global_role, 'INVITATION_ROLE_UNKNOWN');
    /* An invitation has no member row, so no assignment can reference it. A non-empty
       set here would be a room privilege attached to someone who cannot hold one. */
    if (row.assignments.length > 0) throw new Error('INVITATION_ASSIGNMENTS_PRESENT');
    return { subjectKind: 'invitation', ...identity, state: 'pending', globalRole };
  }
  throw new Error('MEMBER_SUBJECT_KIND_UNKNOWN');
}

export async function readMembers(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  /**
   * Both components or neither. A partial cursor is passed through rather than
   * rejected here, because `read_members` is the authority on it and raises 22023,
   * which the failure mapping renders as the designed 400. Deciding it twice would
   * let the two disagree.
   */
  readonly afterCreatedAt?: string | null;
  readonly afterSubjectId?: string | null;
  readonly limit?: number;
}): Promise<MemberPage> {
  const limit = input.limit ?? MEMBER_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MEMBER_PAGE_LIMIT)
    throw new Error('MEMBER_PAGE_LIMIT_REJECTED');
  /*
   * ONE query, so the subjects and their rooms come from one snapshot, and every
   * subject carries its complete active assignment set.
   *
   * This used to be two calls -- a page of subjects, then a separately bounded page of
   * their assignments -- which could only report that SOMETHING on the page was
   * incomplete. A surface could not tell which member's room list was short, and a
   * short room list reads as that member's whole access. The reader now bounds a page
   * by returning fewer SUBJECTS instead, and the ordinary cursor reaches the rest.
   *
   * A page may therefore be shorter than `limit` and still continue, which is why
   * `continues` is read from the row rather than inferred from the row count.
   */
  const page = await input.pool.query<MemberRow>('SELECT * FROM read_members($1,$2,$3,$4)', [
    input.identity.id,
    input.afterCreatedAt ?? null,
    input.afterSubjectId ?? null,
    limit,
  ]);
  const parsed = page.rows.map((row) => parseSubjectRow(row));
  /*
   * The cursor carries the row's exact server text, not the parsed `Date`, so the
   * next page resumes at precisely the instant this page ended.
   */
  const lastRow = page.rows.at(-1);
  return {
    subjects: parsed,
    ...(lastRow?.continues === true
      ? {
          nextCursor: {
            createdAt: lastRow.cursor_created_at,
            subjectId: lastRow.subject_id,
          },
        }
      : {}),
  };
}

export async function inviteMember(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly email: string;
  readonly intendedRole: AssignableGlobalRole;
}): Promise<InvitedMember> {
  /*
   * §8.2's normalization is implemented once, in the shared normalizer, and both
   * halves of the pair come from it. invite_member re-derives the key from the
   * display value and refuses a pair that disagrees, so a mismatch cannot admit
   * one address while its onboarding mail goes to another.
   */
  const normalized = normalizeEmail(input.email);
  const invitationId = createOpaqueId();
  const result = await input.pool.query<{ invite_member: Date }>(
    'SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)',
    [
      invitationId,
      normalized.comparisonKey,
      normalized.display,
      input.intendedRole,
      input.identity.id,
      createOpaqueId(),
      createOpaqueId(),
      createCorrelationId(),
    ],
  );
  const expiresAt = result.rows[0]?.invite_member;
  if (expiresAt === undefined) throw new Error('MEMBER_INVITATION_FAILED');
  return { invitationId, intendedRole: input.intendedRole, expiresAt };
}

export async function revokeMemberInvitation(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly invitationId: string;
}): Promise<void> {
  await input.pool.query('SELECT revoke_member_invitation($1,$2,$3,$4)', [
    input.invitationId,
    input.identity.id,
    createOpaqueId(),
    createCorrelationId(),
  ]);
}

export async function setMemberGlobalRole(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly memberId: string;
  readonly role: AssignableGlobalRole;
  readonly expectedRevision: number;
}): Promise<{ readonly revision: number }> {
  const result = await input.pool.query<{ set_member_global_role: number }>(
    'SELECT set_member_global_role($1,$2,$3,$4,$5,$6)',
    [
      input.memberId,
      input.role,
      input.identity.id,
      input.expectedRevision,
      createOpaqueId(),
      createCorrelationId(),
    ],
  );
  const revision = result.rows[0]?.set_member_global_role;
  if (revision === undefined) throw new Error('MEMBER_ROLE_CHANGE_FAILED');
  return { revision };
}

export async function setMemberState(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly memberId: string;
  readonly state: MemberState;
  readonly expectedRevision: number;
}): Promise<{ readonly revision: number }> {
  const result = await input.pool.query<{ set_member_state: number }>(
    'SELECT set_member_state($1,$2,$3,$4,$5,$6)',
    [
      input.memberId,
      input.state,
      input.identity.id,
      input.expectedRevision,
      createOpaqueId(),
      createCorrelationId(),
    ],
  );
  const revision = result.rows[0]?.set_member_state;
  if (revision === undefined) throw new Error('MEMBER_STATE_CHANGE_FAILED');
  return { revision };
}

export async function dryRunOwnershipTransfer(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly memberId: string;
}): Promise<OwnershipTransferImpact> {
  /*
   * The preview id is generated here and recorded by the function, so the apply
   * that follows can prove this dry run happened. It is opaque and single-use.
   */
  const previewId = createOpaqueId();
  const result = await input.pool.query<{
    dry_run_ownership_transfer: OwnershipTransferImpact;
  }>('SELECT dry_run_ownership_transfer($1,$2,$3)', [
    previewId,
    input.memberId,
    input.identity.id,
  ]);
  const impact = result.rows[0]?.dry_run_ownership_transfer;
  if (impact === undefined) throw new Error('OWNERSHIP_IMPACT_UNAVAILABLE');
  /*
   * The disclosed rooms are validated rather than passed through: a role this process
   * does not recognize in the impact the Owner is about to approve must fail closed,
   * not render as something it guessed.
   */
  for (const assignment of impact.revokedAssignments)
    oneOf(ROOM_ROLES, assignment.roomRole, 'ROOM_ROLE_UNKNOWN');
  return impact;
}

/**
 * Transfers ownership.
 *
 * `previewId` is the server-issued record of the required dry run, consumed once
 * inside `transfer_ownership`. Without it the function refuses: the confirmation
 * phrase is a constant, so comparing it alone proved only that the caller had read
 * the documentation, and §9.4's dry-run gate would be decorative.
 *
 * The authentication instant is passed through and judged inside
 * `transfer_ownership`; it is session-bound evidence the caller cannot supply, and
 * the authoritative freshness decision belongs with the mutation (§9.4).
 *
 * `member_privilege_session_revoke` revokes the acting Owner's sessions inside
 * this transaction, so this call succeeds on a session that no longer exists. The
 * caller must treat the following 401 as the documented outcome of a completed
 * transfer, not as a failure.
 *
 * The preview's recorded assignment digest is re-checked inside the same function,
 * under the target's row lock, before the demotion. The Owner approved a named set of
 * assignments to be revoked, and `member.revision` does not move when a
 * `room_assignment` row changes, so without that check a concurrent `assign-rooms`
 * would have the transfer revoke a set the Owner never saw. A mismatch is 40001.
 */
export async function transferOwnership(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly memberId: string;
  readonly expectedRevision: number;
  readonly previewId: string;
  readonly confirmation: string;
}): Promise<void> {
  await input.pool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
    input.memberId,
    input.identity.id,
    input.expectedRevision,
    input.identity.oidcAuthenticatedAt ?? null,
    input.previewId,
    input.confirmation,
    createOpaqueId(),
    createCorrelationId(),
  ]);
}

/**
 * Applies one member's complete assignment change as a single batch.
 *
 * `room_assignment_privilege_session_revoke` fires on every room_assignment row
 * change and revokes all of that member's active sessions, so four per-room calls
 * would sign them out four times. One transaction is one revocation, which is why
 * this takes a batch rather than a room.
 */
export async function applyRoomAssignments(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly memberId: string;
  readonly assign: readonly RoomAssignment[];
  readonly revoke: readonly string[];
}): Promise<AppliedAssignments> {
  const result = await input.pool.query<{ apply_room_assignments: AppliedAssignments }>(
    'SELECT apply_room_assignments($1,$2::jsonb,$3::jsonb,$4,$5,$6)',
    [
      input.memberId,
      JSON.stringify(input.assign),
      JSON.stringify(input.revoke),
      input.identity.id,
      createOpaqueId(),
      createCorrelationId(),
    ],
  );
  const applied = result.rows[0]?.apply_room_assignments;
  if (applied === undefined) throw new Error('ROOM_ASSIGNMENT_FAILED');
  for (const assignment of applied.assignments)
    oneOf(ROOM_ROLES, assignment.roomRole, 'ROOM_ROLE_UNKNOWN');
  return applied;
}
