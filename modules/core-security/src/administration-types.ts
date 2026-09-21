import type { GlobalRole, RoomRole } from './authorization.ts';

export type AssignableGlobalRole = Extract<GlobalRole, 'admin' | 'member'>;
export type MemberState = 'active' | 'disabled';

export interface RoomAssignment {
  readonly roomId: string;
  readonly roomRole: RoomRole;
}

interface SubjectIdentity {
  readonly subjectId: string;
  readonly emailDisplay: string;
  readonly revision: number;
  readonly createdAt: Date;
}

export interface SubjectCapabilities {
  readonly setRole: boolean;
  readonly setState: boolean;
  readonly assignRooms: boolean;
  readonly transfer: boolean;
}

export interface ProvisionedMemberSubject extends SubjectIdentity {
  readonly subjectKind: 'member';
  readonly globalRole: GlobalRole;
  readonly state: MemberState;
  readonly assignments: readonly RoomAssignment[];
  readonly capabilities: SubjectCapabilities;
}

export interface PendingInvitationSubject extends SubjectIdentity {
  readonly subjectKind: 'invitation';
  readonly state: 'pending';
  readonly globalRole: AssignableGlobalRole;
}

export type MemberSubject = ProvisionedMemberSubject | PendingInvitationSubject;

export interface MemberPageCursor {
  // Kept as server text to preserve PostgreSQL microseconds across keyset requests.
  readonly createdAt: string;
  readonly subjectId: string;
}

export interface MemberPage {
  readonly subjects: readonly MemberSubject[];
  readonly nextCursor?: MemberPageCursor;
}

export interface InvitedMember {
  readonly invitationId: string;
  readonly intendedRole: AssignableGlobalRole;
  readonly expiresAt: Date;
}

export interface RevokedAssignmentPreview {
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
  readonly revokedAssignments: readonly RevokedAssignmentPreview[];
  readonly revokedAssignmentsTruncated: boolean;
}

export interface AppliedAssignments {
  readonly memberId: string;
  readonly changed: number;
  readonly assignments: readonly RoomAssignment[];
}

export const MEMBER_PAGE_LIMIT = 50;
export const MAX_MEMBER_PAGE_LIMIT = 100;
// Shared by the reader and mutation so every returned member has a complete assignment set.
export const MAX_MEMBER_ASSIGNMENTS = 500;
