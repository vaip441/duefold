import { useState } from 'react';
import {
  applyRoomAssignments,
  revokeMemberInvitation,
  setMemberRole,
  setMemberState,
  type AssignableGlobalRole,
  type MemberState,
  type RoomAssignment,
} from '../api/client.ts';
import type { PresentedFailure } from './failures.ts';
import { committed } from './outcome.ts';

/**
 * The four row mutations, and where each one's refusal is shown.
 *
 * Every mutation moves a revision the next optimistic write depends on, and a role change
 * or an assignment batch revokes the target's sessions, so nothing here patches state
 * locally: each success re-reads the list from the server.
 */
export function useMemberMutations(input: {
  readonly refresh: () => void;
  readonly onInvitationRevoked: () => void;
  readonly onRoleChanged: () => void;
  readonly onStateChanged: () => void;
  readonly onAssigned: () => void;
}) {
  const [busySubjectId, setBusySubjectId] = useState<string | null>(null);
  const [changeFailure, setChangeFailure] = useState<PresentedFailure | null>(null);

  /**
   * Runs one mutation and RETURNS its refusal rather than deciding where to show it.
   *
   * Where a refusal belongs is the caller's own business: `actAtTable` puts it on the table,
   * and the assignment dialog keeps its own beside the draft that caused it. One helper
   * deciding for both would hold two surfaces' presentation rules.
   */
  const act = (
    subjectId: string,
    run: () => Promise<unknown>,
    done: () => void,
  ): Promise<PresentedFailure | null> => {
    setBusySubjectId(subjectId);
    setChangeFailure(null);
    return committed(run()).then((failure) => {
      setBusySubjectId(null);
      if (failure === null) {
        done();
        input.refresh();
      }
      return failure;
    });
  };

  /** A mutation started from a row, so its refusal is reported at the table. */
  const actAtTable = (
    subjectId: string,
    run: () => Promise<unknown>,
    done: () => void,
  ): void => {
    void act(subjectId, run, done).then((failure) => {
      if (failure !== null) setChangeFailure(failure);
    });
  };

  return {
    busySubjectId,
    changeFailure,
    revokeInvitation: (invitationId: string): void => {
      actAtTable(
        invitationId,
        () => revokeMemberInvitation(invitationId),
        input.onInvitationRevoked,
      );
    },
    /* Both sign the member out everywhere, so they run from a confirmation dialog that
       stays open through a refusal and needs the answer to its own change. */
    changeRole: (change: {
      readonly memberId: string;
      readonly role: AssignableGlobalRole;
      readonly expectedRevision: number;
    }): Promise<PresentedFailure | null> =>
      act(change.memberId, () => setMemberRole(change), input.onRoleChanged),
    changeState: (change: {
      readonly memberId: string;
      readonly state: MemberState;
      readonly expectedRevision: number;
    }): Promise<PresentedFailure | null> =>
      act(change.memberId, () => setMemberState(change), input.onStateChanged),
    /*
     * The only mutation whose answer goes back to its caller. The dialog must stay open
     * through pending and through a refusal -- closing on submit discarded a multi-room
     * draft -- so it needs to know that ITS batch committed. `null` means it did.
     */
    assign: (change: {
      readonly memberId: string;
      readonly assign: readonly RoomAssignment[];
      readonly revoke: readonly string[];
    }): Promise<PresentedFailure | null> =>
      act(change.memberId, () => applyRoomAssignments(change), input.onAssigned),
    dismissChangeFailure: (): void => {
      setChangeFailure(null);
    },
  };
}
