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

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  applyGrantChange,
  createCounterparty,
  dryRunGrantChange,
  inviteParticipant,
  loadParticipants,
  placeViewerInCounterparty,
  removeViewerFromCounterparty,
  type GrantImpact,
  type ParticipantRoster,
} from '../api/client.ts';
import { presentFailure, type PresentedFailure } from './failures.ts';
import { draftToRequest, granteeRequest, type GrantSubmission } from './grants.ts';
import { committed, settle, type Outcome } from './outcome.ts';
import { readFor } from './room-settings.ts';
import type { Load } from './state.ts';

export interface ParticipantsSection {
  readonly roster: Load<ParticipantRoster>;
  readonly failure: PresentedFailure | null;
  readonly inviteFailure: PresentedFailure | null;
  readonly invitePending: boolean;
  readonly impact: GrantImpact | null;
  readonly impactPending: boolean;
  readonly applyPending: boolean;
  readonly changeFailure: PresentedFailure | null;
  readonly refresh: (roomId: string, signal?: AbortSignal) => void;
  readonly beginLoading: () => void;
  /** Resolves true once the invitation is sent. */
  readonly invite: (input: {
    roomId: string;
    email: string;
    expectedRoomRevision: number;
  }) => Promise<boolean>;
  readonly review: (roomId: string, submission: GrantSubmission) => void;
  /** Resolves true once the reviewed change is committed. */
  readonly apply: (input: {
    roomId: string;
    expectedRoomRevision: number;
    confirmation: string;
  }) => Promise<boolean>;
  readonly cancelChange: () => void;
  readonly previewGrant: (
    roomId: string,
    submission: GrantSubmission,
  ) => Promise<Outcome<GrantImpact>>;
  readonly commitGrant: (input: {
    readonly roomId: string;
    readonly submission: GrantSubmission;
    readonly impact: GrantImpact;
    readonly expectedRoomRevision: number;
    readonly confirmation: string;
  }) => Promise<PresentedFailure | null>;
  readonly addCounterparty: (input: {
    readonly roomId: string;
    readonly name: string;
    readonly expectedRoomRevision: number;
  }) => Promise<PresentedFailure | null>;
  readonly placeViewer: (input: {
    readonly roomId: string;
    readonly counterpartyId: string;
    readonly viewerId: string;
    readonly expectedRoomRevision: number;
  }) => Promise<PresentedFailure | null>;
  readonly removeViewer: (input: {
    readonly roomId: string;
    readonly viewerId: string;
    readonly expectedRoomRevision: number;
  }) => Promise<PresentedFailure | null>;
}

export function useParticipantsSection(handlers: {
  readonly onInvited: (email: string) => void;
  readonly onApplied: () => void;
  readonly onRosterChanged: () => void;
}): ParticipantsSection {
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  /*
   * Tagged with the room it describes. This view is reused as the member moves between rooms,
   * so a read or a post-mutation refresh that resolves after they have left would otherwise
   * put one room's readers, counterparties and grants on another room's Access section.
   * `readFor` answers `loading` rather than the wrong room's value.
   */
  const [read, setRead] = useState<{
    readonly roomId: string;
    readonly load: Load<ParticipantRoster>;
  } | null>(null);
  const openRoomId = useRef<string | null>(null);
  const [failure, setFailure] = useState<PresentedFailure | null>(null);
  const [inviteFailure, setInviteFailure] = useState<PresentedFailure | null>(null);
  const [invitePending, setInvitePending] = useState(false);
  const [impact, setImpact] = useState<GrantImpact | null>(null);
  /* A ref, not state: a review that resolves after its draft was changed or cancelled must
     see that, or it would show an impact for a target no longer on screen. */
  const submission = useRef<GrantSubmission | null>(null);
  const [impactPending, setImpactPending] = useState(false);
  const [applyPending, setApplyPending] = useState(false);
  const [changeFailure, setChangeFailure] = useState<PresentedFailure | null>(null);

  const refresh = useCallback((roomId: string, signal?: AbortSignal): void => {
    openRoomId.current = roomId;
    setFailure(null);
    loadParticipants(roomId, signal).then(
      (value) => {
        if (!mounted.current) return;
        setRead({ roomId, load: { kind: 'ready', value } });
      },
      (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        if (!mounted.current) return;
        const presented = presentFailure(error);
        setRead({ roomId, load: { kind: 'failed', failure: presented.title } });
        setFailure(presented);
      },
    );
  }, []);

  /* Only for the room still open: a mutation that resolved after the member moved on must not
     reload a room nobody is looking at, nor tell the frame that one changed. */
  const settled = useCallback((roomId: string): boolean => {
    return mounted.current && openRoomId.current === roomId;
  }, []);

  const beginLoading = useCallback((): void => {
    setRead(null);
  }, []);

  const invite: ParticipantsSection['invite'] = (input) => {
    setInvitePending(true);
    setInviteFailure(null);
    return inviteParticipant(input).then(
      () => {
        if (!mounted.current) return false;
        setInvitePending(false);
        handlers.onInvited(input.email);
        refresh(input.roomId);
        return true;
      },
      (error: unknown) => {
        if (!mounted.current) return false;
        setInvitePending(false);
        setInviteFailure(presentFailure(error));
        return false;
      },
    );
  };

  const previewGrant: ParticipantsSection['previewGrant'] = (roomId, next) =>
    settle(
      dryRunGrantChange({
        roomId,
        changeAction: next.draft.changeAction,
        ...(next.grantId === undefined ? {} : { grantId: next.grantId }),
        ...granteeRequest(next.grantee),
        ...draftToRequest(next.draft),
      }),
    );

  const commitGrant: ParticipantsSection['commitGrant'] = async (input) => {
    const failure = await committed(
      applyGrantChange({
        roomId: input.roomId,
        changeAction: input.submission.draft.changeAction,
        // The server's own grantId, not one chosen here.
        grantId: input.impact.grantId,
        ...granteeRequest(input.submission.grantee),
        ...draftToRequest(input.submission.draft),
        expectedRoomRevision: input.expectedRoomRevision,
        confirmation: input.confirmation,
      }),
    );
    if (failure === null && settled(input.roomId)) {
      handlers.onApplied();
      refresh(input.roomId);
    }
    return failure;
  };

  const review: ParticipantsSection['review'] = (roomId, next) => {
    submission.current = next;
    setImpact(null);
    setChangeFailure(null);
    setImpactPending(true);
    void previewGrant(roomId, next).then((outcome) => {
      if (!mounted.current || submission.current !== next) return;
      setImpactPending(false);
      if (outcome.ok) setImpact(outcome.value);
      else setChangeFailure(outcome.failure);
    });
  };

  const apply: ParticipantsSection['apply'] = async (input) => {
    const current = submission.current;
    const reviewed = impact;
    if (current === null || reviewed === null) return false;
    setApplyPending(true);
    setChangeFailure(null);
    const failure = await commitGrant({ ...input, submission: current, impact: reviewed });
    if (!mounted.current) return false;
    setApplyPending(false);
    if (failure !== null) {
      setChangeFailure(failure);
      return false;
    }
    setImpact(null);
    submission.current = null;
    return true;
  };

  const cancelChange = useCallback((): void => {
    submission.current = null;
    setImpact(null);
    setImpactPending(false);
    setChangeFailure(null);
  }, []);

  const rosterChange = async (
    roomId: string,
    work: Promise<unknown>,
  ): Promise<PresentedFailure | null> => {
    const failure = await committed(work);
    if (failure === null && settled(roomId)) {
      handlers.onRosterChanged();
      refresh(roomId);
    }
    return failure;
  };

  return {
    roster: readFor(read, openRoomId.current) ?? { kind: 'loading' },
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
    previewGrant,
    commitGrant,
    addCounterparty: (input) => rosterChange(input.roomId, createCounterparty(input)),
    placeViewer: (input) => rosterChange(input.roomId, placeViewerInCounterparty(input)),
    removeViewer: (input) => rosterChange(input.roomId, removeViewerFromCounterparty(input)),
  };
}
