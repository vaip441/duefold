/**
 * Participants and grants section state.
 *
 * Extracted from `Workspace`, which had grown to hold seven unrelated section state
 * machines in one component. The behaviour is unchanged; only the ownership moved.
 *
 * Two properties this hook must preserve, because both were defects once:
 *
 * 1. Grant impact is whatever the SERVER returned. No count, path, or confirmation
 *    phrase is computed here, and apply echoes the server's `grantId` together with
 *    the room revision the client last read.
 * 2. A failed load becomes `failed`, never `ready` with an empty list. Rendering
 *    "no participants" for a refusal represents inaccessible data as absent.
 */

import { useCallback, useState } from 'react';
import {
  applyGrantChange,
  dryRunGrantChange,
  inviteParticipant,
  loadParticipants,
  type GrantImpact,
  type Participant,
} from '../api/client.ts';
import { presentFailure, type PresentedFailure } from './failures.ts';
import { draftToRequest, type GrantSubmission } from './grants.ts';
import type { Load } from './state.ts';

export interface ParticipantsSection {
  readonly participants: Load<readonly Participant[]>;
  readonly failure: PresentedFailure | null;
  readonly inviteFailure: PresentedFailure | null;
  readonly invitePending: boolean;
  readonly impact: GrantImpact | null;
  readonly impactPending: boolean;
  readonly applyPending: boolean;
  readonly changeFailure: PresentedFailure | null;
  readonly refresh: (roomId: string, signal?: AbortSignal) => void;
  readonly beginLoading: () => void;
  readonly invite: (input: {
    roomId: string;
    email: string;
    expectedRoomRevision: number;
  }) => void;
  readonly review: (roomId: string, submission: GrantSubmission) => void;
  readonly apply: (input: {
    roomId: string;
    expectedRoomRevision: number;
    confirmation: string;
  }) => void;
  readonly cancelChange: () => void;
}

export function useParticipantsSection(handlers: {
  readonly onInvited: (email: string) => void;
  readonly onApplied: () => void;
}): ParticipantsSection {
  const [participants, setParticipants] = useState<Load<readonly Participant[]>>({
    kind: 'loading',
  });
  const [failure, setFailure] = useState<PresentedFailure | null>(null);
  const [inviteFailure, setInviteFailure] = useState<PresentedFailure | null>(null);
  const [invitePending, setInvitePending] = useState(false);
  const [impact, setImpact] = useState<GrantImpact | null>(null);
  const [submission, setSubmission] = useState<GrantSubmission | null>(null);
  const [impactPending, setImpactPending] = useState(false);
  const [applyPending, setApplyPending] = useState(false);
  const [changeFailure, setChangeFailure] = useState<PresentedFailure | null>(null);

  const refresh = useCallback((roomId: string, signal?: AbortSignal): void => {
    setFailure(null);
    loadParticipants(roomId, signal).then(
      (value) => {
        setParticipants({ kind: 'ready', value });
      },
      (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        const presented = presentFailure(error);
        setParticipants({ kind: 'failed', failure: presented.title });
        setFailure(presented);
      },
    );
  }, []);

  const beginLoading = useCallback((): void => {
    setParticipants({ kind: 'loading' });
  }, []);

  const invite: ParticipantsSection['invite'] = (input) => {
    setInvitePending(true);
    setInviteFailure(null);
    inviteParticipant(input).then(
      () => {
        setInvitePending(false);
        handlers.onInvited(input.email);
        refresh(input.roomId);
      },
      (error: unknown) => {
        setInvitePending(false);
        setInviteFailure(presentFailure(error));
      },
    );
  };

  const review: ParticipantsSection['review'] = (roomId, next) => {
    setSubmission(next);
    setImpact(null);
    setChangeFailure(null);
    setImpactPending(true);
    dryRunGrantChange({
      roomId,
      changeAction: next.draft.changeAction,
      ...(next.grantId === undefined ? {} : { grantId: next.grantId }),
      granteeKind: 'viewer',
      viewerId: next.participant.viewerId,
      counterpartyId: null,
      ...draftToRequest(next.draft),
    }).then(
      (value) => {
        setImpactPending(false);
        setImpact(value);
      },
      (error: unknown) => {
        setImpactPending(false);
        setChangeFailure(presentFailure(error));
      },
    );
  };

  const apply: ParticipantsSection['apply'] = (input) => {
    const current = submission;
    const reviewed = impact;
    if (current === null || reviewed === null) return;
    setApplyPending(true);
    setChangeFailure(null);
    applyGrantChange({
      roomId: input.roomId,
      changeAction: current.draft.changeAction,
      // The server's own grantId, not one chosen here.
      grantId: reviewed.grantId,
      granteeKind: 'viewer',
      viewerId: current.participant.viewerId,
      counterpartyId: null,
      ...draftToRequest(current.draft),
      expectedRoomRevision: input.expectedRoomRevision,
      confirmation: input.confirmation,
    }).then(
      () => {
        setApplyPending(false);
        setImpact(null);
        setSubmission(null);
        handlers.onApplied();
        refresh(input.roomId);
      },
      (error: unknown) => {
        setApplyPending(false);
        setChangeFailure(presentFailure(error));
      },
    );
  };

  const cancelChange = useCallback((): void => {
    setImpact(null);
    setSubmission(null);
    setChangeFailure(null);
  }, []);

  return {
    participants,
    failure,
    inviteFailure,
    invitePending,
    impact,
    impactPending,
    applyPending,
    changeFailure,
    refresh,
    beginLoading,
    invite,
    review,
    apply,
    cancelChange,
  };
}
