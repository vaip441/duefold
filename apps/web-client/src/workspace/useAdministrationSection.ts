/**
 * Members, invitations, roles, states, assignments, and ownership transfer.
 *
 * Three properties this hook exists to keep:
 *
 * 1. A FAILED LOAD IS `failed`, NEVER `ready` WITH AN EMPTY PAGE. "You are the only
 *    member" beside a refusal would tell an administrator that withheld people do
 *    not exist. The denied state is its own state.
 * 2. COMPLETENESS COMES FROM THE SERVER'S CURSOR. Each subject carries its complete
 *    assignment set, but a page of subjects can be short and still continue, so
 *    `nextCursor` is the only signal that the list is whole. The hook keeps it and
 *    the surface says so; nothing infers completeness from a row count.
 * 3. A COMPLETED TRANSFER IS NOT A FAILURE. The transfer revokes the acting Owner's
 *    sessions inside its own transaction, so `session-ended` is the successful
 *    outcome and is reported as one.
 *
 * No role is read or branched on here. Every refusal is the server's, and a control
 * this surface offers is never treated as a permission.
 */

import { useCallback, useState } from 'react';
import {
  applyOwnershipTransfer,
  applyRoomAssignments,
  dryRunOwnershipTransfer,
  inviteMember,
  loadMembers,
  revokeMemberInvitation,
  setMemberRole,
  setMemberState,
  type AssignableGlobalRole,
  type MemberPageCursor,
  type MemberState,
  type MemberSubject,
  type OwnershipTransferImpact,
  type RoomAssignment,
} from '../api/client.ts';
import { presentFailure, type PresentedFailure } from './failures.ts';
import type { Load } from './state.ts';

/** Which row operation a reported failure came from, and the subject it acted on. */
export interface ChangeFailureOrigin {
  readonly operation: 'role' | 'state' | 'invitation' | 'assignment';
  readonly subjectId: string;
}

/**
 * What the surface knows about the member list.
 *
 * `nextCursor` is carried rather than collapsed into a boolean so the next page
 * resumes at exactly the instant this page ended; the server's timestamp text is
 * echoed unmodified.
 */
export interface MemberListing {
  readonly subjects: readonly MemberSubject[];
  readonly nextCursor: MemberPageCursor | null;
}

export interface AdministrationSection {
  readonly listing: Load<MemberListing>;
  readonly failure: PresentedFailure | null;
  readonly loadingMore: boolean;
  readonly inviteFailure: PresentedFailure | null;
  readonly invitePending: boolean;
  /** The subject a per-row action is currently running against. */
  readonly busySubjectId: string | null;
  readonly changeFailure: PresentedFailure | null;
  /**
   * WHICH operation the current `changeFailure` came from, and for whom.
   *
   * Role, state, invitation-revocation and assignment all report through one failure
   * field, so without provenance the assignment dialog could not tell whose failure it was
   * holding. It displayed whatever was last set: after any failed row mutation, opening
   * room assignment for that member — or for anyone else — showed that unrelated error as
   * if it belonged to the fresh draft.
   *
   * Null whenever `changeFailure` is null. Recorded rather than cleared on open, so a
   * genuine assignment failure survives a retry inside the same dialog and the table keeps
   * reporting a row failure that is still true.
   */
  readonly changeFailureOrigin: ChangeFailureOrigin | null;
  readonly transferImpact: OwnershipTransferImpact | null;
  readonly transferImpactPending: boolean;
  readonly transferPending: boolean;
  readonly transferFailure: PresentedFailure | null;
  /**
   * Confirmed assignment batches, counted.
   *
   * A COUNTER RATHER THAN A BOOLEAN, because the surface acts on the CHANGE. The
   * assignment dialog must stay open through pending and through a refusal — closing on
   * submit discarded a multi-room draft and reported the failure behind the table — so it
   * needs to know that a batch actually committed. Inferring that from "pending cleared
   * and no failure is on screen" would close the dialog on a failure whose state had not
   * landed yet, which is the same lost draft by a subtler route.
   */
  readonly assignmentsApplied: number;
  /** True once a transfer completed and ended this session. Terminal. */
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
  }) => void;
  readonly changeState: (input: {
    readonly memberId: string;
    readonly state: MemberState;
    readonly expectedRevision: number;
  }) => void;
  readonly assign: (input: {
    readonly memberId: string;
    readonly assign: readonly RoomAssignment[];
    readonly revoke: readonly string[];
  }) => void;
  readonly reviewTransfer: (memberId: string) => void;
  readonly applyTransfer: (input: {
    readonly memberId: string;
    readonly previewId: string;
    readonly expectedRevision: number;
    readonly confirmation: string;
  }) => void;
  readonly cancelTransfer: () => void;
  readonly dismissChangeFailure: () => void;
}

export function useAdministrationSection(handlers: {
  readonly onInvited: (email: string) => void;
  readonly onInvitationRevoked: () => void;
  readonly onRoleChanged: () => void;
  readonly onStateChanged: () => void;
  readonly onAssigned: () => void;
  readonly onTransferred: () => void;
}): AdministrationSection {
  const [listing, setListing] = useState<Load<MemberListing>>({ kind: 'loading' });
  const [failure, setFailure] = useState<PresentedFailure | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [inviteFailure, setInviteFailure] = useState<PresentedFailure | null>(null);
  const [invitePending, setInvitePending] = useState(false);
  const [busySubjectId, setBusySubjectId] = useState<string | null>(null);
  const [changeFailure, setChangeFailure] = useState<PresentedFailure | null>(null);
  const [changeFailureOrigin, setChangeFailureOrigin] = useState<ChangeFailureOrigin | null>(
    null,
  );
  const [transferImpact, setTransferImpact] = useState<OwnershipTransferImpact | null>(null);
  const [transferImpactPending, setTransferImpactPending] = useState(false);
  const [transferPending, setTransferPending] = useState(false);
  const [transferFailure, setTransferFailure] = useState<PresentedFailure | null>(null);
  const [assignmentsApplied, setAssignmentsApplied] = useState(0);
  const [sessionEnded, setSessionEnded] = useState(false);

  const refresh = useCallback((signal?: AbortSignal): void => {
    setFailure(null);
    loadMembers(signal === undefined ? {} : { signal }).then(
      (page) => {
        setListing({
          kind: 'ready',
          value: { subjects: page.subjects, nextCursor: page.nextCursor },
        });
      },
      (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        const presented = presentFailure(error);
        setListing({ kind: 'failed', failure: presented.title });
        setFailure(presented);
      },
    );
  }, []);

  const beginLoading = useCallback((): void => {
    setListing({ kind: 'loading' });
  }, []);

  /**
   * Runs a mutation, then re-reads the list from the server.
   *
   * Never patches state locally. Every mutation here moves a revision the next
   * optimistic write depends on, and a role change or an assignment batch revokes
   * the target's sessions, so the authoritative state is the server's.
   */
  const act = (
    subjectId: string,
    operation: ChangeFailureOrigin['operation'],
    run: () => Promise<unknown>,
    done: () => void,
  ): void => {
    setBusySubjectId(subjectId);
    setChangeFailure(null);
    setChangeFailureOrigin(null);
    run().then(
      () => {
        setBusySubjectId(null);
        done();
        refresh();
      },
      (error: unknown) => {
        setBusySubjectId(null);
        setChangeFailure(presentFailure(error));
        /* Recorded with the failure, so the surface that caused it is the only one that
           presents it. */
        setChangeFailureOrigin({ operation, subjectId });
      },
    );
  };

  return {
    listing,
    failure,
    loadingMore,
    inviteFailure,
    invitePending,
    busySubjectId,
    changeFailure,
    changeFailureOrigin,
    transferImpact,
    transferImpactPending,
    transferPending,
    transferFailure,
    assignmentsApplied,
    sessionEnded,
    refresh,
    beginLoading,
    loadMore: () => {
      if (listing.kind !== 'ready' || listing.value.nextCursor === null) return;
      const after = listing.value.nextCursor;
      setLoadingMore(true);
      setFailure(null);
      loadMembers({ after }).then(
        (page) => {
          setLoadingMore(false);
          setListing((current) =>
            current.kind === 'ready'
              ? {
                  kind: 'ready',
                  value: {
                    subjects: [...current.value.subjects, ...page.subjects],
                    nextCursor: page.nextCursor,
                  },
                }
              : current,
          );
        },
        (error: unknown) => {
          setLoadingMore(false);
          /* The pages already read stay on screen: they are complete for the
             subjects they name, and discarding them would lose information the
             server did give. The failure says the rest is unread. */
          setFailure(presentFailure(error));
        },
      );
    },
    invite: (input) => {
      setInvitePending(true);
      setInviteFailure(null);
      inviteMember(input).then(
        () => {
          setInvitePending(false);
          handlers.onInvited(input.email);
          refresh();
        },
        (error: unknown) => {
          setInvitePending(false);
          setInviteFailure(presentFailure(error));
        },
      );
    },
    revokeInvitation: (invitationId) => {
      act(
        invitationId,
        'invitation',
        () => revokeMemberInvitation(invitationId),
        handlers.onInvitationRevoked,
      );
    },
    changeRole: (input) => {
      act(input.memberId, 'role', () => setMemberRole(input), handlers.onRoleChanged);
    },
    changeState: (input) => {
      act(input.memberId, 'state', () => setMemberState(input), handlers.onStateChanged);
    },
    assign: (input) => {
      act(
        input.memberId,
        'assignment',
        () => applyRoomAssignments(input),
        () => {
          /* Counted only HERE, on the resolved batch, so the dialog closes on a
             committed change and on nothing else. */
          setAssignmentsApplied((applied) => applied + 1);
          handlers.onAssigned();
        },
      );
    },
    reviewTransfer: (memberId) => {
      setTransferImpactPending(true);
      setTransferFailure(null);
      setTransferImpact(null);
      dryRunOwnershipTransfer(memberId).then(
        (impact) => {
          setTransferImpactPending(false);
          setTransferImpact(impact);
        },
        (error: unknown) => {
          setTransferImpactPending(false);
          setTransferFailure(presentFailure(error));
        },
      );
    },
    applyTransfer: (input) => {
      setTransferPending(true);
      setTransferFailure(null);
      applyOwnershipTransfer(input).then(
        (result) => {
          setTransferPending(false);
          setTransferImpact(null);
          if (result.outcome === 'session-ended') {
            /* Terminal and successful. The session is gone, so nothing is
               refreshed: a reload would only produce a 401 the surface would have
               to explain a second time. */
            setSessionEnded(true);
            return;
          }
          handlers.onTransferred();
          refresh();
        },
        (error: unknown) => {
          setTransferPending(false);
          /* A 409 means the target changed after the preview was issued, so the
             preview no longer describes what would happen. It is dropped rather
             than left on screen, and the Owner previews again. */
          const presented = presentFailure(error);
          if (presented.kind === 'conflict') setTransferImpact(null);
          setTransferFailure(presented);
        },
      );
    },
    cancelTransfer: () => {
      setTransferImpact(null);
      setTransferFailure(null);
    },
    dismissChangeFailure: () => {
      setChangeFailure(null);
      setChangeFailureOrigin(null);
    },
  };
}
