import type {
  AssignableGlobalRole,
  MemberState,
  OwnershipTransferImpact,
  RoomAssignment,
} from '../api/client.ts';
import type { PresentedFailure } from './failures.ts';
import type { Load } from './state.ts';
import { useMemberListing, type MemberListing } from './useMemberListing.ts';
import { useMemberMutations } from './useMemberMutations.ts';
import { useOwnershipTransfer } from './useOwnershipTransfer.ts';

export type { MemberListing };

export interface AdministrationSection {
  readonly listing: Load<MemberListing>;
  readonly failure: PresentedFailure | null;
  readonly loadingMore: boolean;
  readonly inviteFailure: PresentedFailure | null;
  readonly invitePending: boolean;
  readonly busySubjectId: string | null;
  readonly changeFailure: PresentedFailure | null;
  readonly transferImpact: OwnershipTransferImpact | null;
  readonly transferImpactPending: boolean;
  readonly transferPending: boolean;
  readonly transferFailure: PresentedFailure | null;
  readonly sessionEnded: boolean;
  readonly refresh: (signal?: AbortSignal) => void;
  readonly beginLoading: () => void;
  readonly loadMore: () => void;
  readonly invite: (input: {
    readonly email: string;
    readonly intendedRole: AssignableGlobalRole;
  }) => void;
  readonly revokeInvitation: (invitationId: string) => void;
  readonly changeRole: (input: {
    readonly memberId: string;
    readonly role: AssignableGlobalRole;
    readonly expectedRevision: number;
  }) => Promise<PresentedFailure | null>;
  readonly changeState: (input: {
    readonly memberId: string;
    readonly state: MemberState;
    readonly expectedRevision: number;
  }) => Promise<PresentedFailure | null>;
  readonly assign: (input: {
    readonly memberId: string;
    readonly assign: readonly RoomAssignment[];
    readonly revoke: readonly string[];
  }) => Promise<PresentedFailure | null>;
  readonly reviewTransfer: ReturnType<typeof useOwnershipTransfer>['reviewTransfer'];
  readonly applyTransfer: ReturnType<typeof useOwnershipTransfer>['applyTransfer'];
  readonly cancelTransfer: ReturnType<typeof useOwnershipTransfer>['cancelTransfer'];
  readonly dismissChangeFailure: () => void;
}

export function useAdministrationSection(handlers: {
  readonly onInvited: (email: string) => void;
  readonly onInvitationRevoked: () => void;
  readonly onRoleChanged: () => void;
  readonly onStateChanged: () => void;
  readonly onAssigned: () => void;
}): AdministrationSection {
  const listing = useMemberListing(handlers.onInvited);
  const mutations = useMemberMutations({
    refresh: listing.refresh,
    onInvitationRevoked: handlers.onInvitationRevoked,
    onRoleChanged: handlers.onRoleChanged,
    onStateChanged: handlers.onStateChanged,
    onAssigned: handlers.onAssigned,
  });
  const transfer = useOwnershipTransfer();

  return { ...listing, ...mutations, ...transfer };
}
