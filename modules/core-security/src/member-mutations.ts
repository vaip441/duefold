import { normalizeEmail } from '@duefold/shared/email';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import type { Pool } from 'pg';
import type { MemberIdentity, RoomRole } from './authorization.ts';
import type {
  AppliedAssignments,
  AssignableGlobalRole,
  InvitedMember,
  MemberState,
  OwnershipTransferImpact,
  RoomAssignment,
} from './administration-types.ts';

const ROOM_ROLES: readonly RoomRole[] = ['manager', 'contributor'];

function roomRole(value: string): RoomRole {
  if (!(ROOM_ROLES as readonly string[]).includes(value)) throw new Error('ROOM_ROLE_UNKNOWN');
  return value as RoomRole;
}

export async function inviteMember(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly email: string;
  readonly intendedRole: AssignableGlobalRole;
}): Promise<InvitedMember> {
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
  for (const assignment of impact.revokedAssignments) roomRole(assignment.roomRole);
  return impact;
}

export async function transferOwnership(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly memberId: string;
  readonly expectedRevision: number;
  readonly previewId: string;
  readonly confirmation: string;
}): Promise<void> {
  // The database consumes the preview and checks freshness, revision, and assignment digest.
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
  for (const assignment of applied.assignments) roomRole(assignment.roomRole);
  return applied;
}
