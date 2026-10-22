import { useCallback, useRef, useState } from 'react';
import {
  inviteMember,
  loadMembers,
  type AssignableGlobalRole,
  type MemberPageCursor,
  type MemberSubject,
} from '../api/client.ts';
import { presentFailure, type PresentedFailure } from './failures.ts';
import type { Load } from './state.ts';

export interface MemberListing {
  readonly subjects: readonly MemberSubject[];
  readonly nextCursor: MemberPageCursor | null;
}

export function useMemberListing(onInvited: (email: string) => void) {
  const [listing, setListing] = useState<Load<MemberListing>>({ kind: 'loading' });
  const [failure, setFailure] = useState<PresentedFailure | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [inviteFailure, setInviteFailure] = useState<PresentedFailure | null>(null);
  const [invitePending, setInvitePending] = useState(false);
  /* The cursor the shown listing continues from. A later page that settles after a refresh
     replaced the listing continues one that is gone, so it is dropped. */
  const continuesFrom = useRef<MemberPageCursor | null>(null);

  const refresh = useCallback((signal?: AbortSignal): void => {
    setFailure(null);
    loadMembers(signal === undefined ? {} : { signal }).then(
      (page) => {
        continuesFrom.current = page.nextCursor;
        setLoadingMore(false);
        setListing({
          kind: 'ready',
          value: { subjects: page.subjects, nextCursor: page.nextCursor },
        });
      },
      (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        const presented = presentFailure(error);
        continuesFrom.current = null;
        setLoadingMore(false);
        setListing({ kind: 'failed', failure: presented.title });
        setFailure(presented);
      },
    );
  }, []);

  const beginLoading = useCallback((): void => {
    continuesFrom.current = null;
    setLoadingMore(false);
    setListing({ kind: 'loading' });
  }, []);

  const loadMore = (): void => {
    if (listing.kind !== 'ready' || listing.value.nextCursor === null) return;
    const after = listing.value.nextCursor;
    setLoadingMore(true);
    setFailure(null);
    loadMembers({ after }).then(
      (page) => {
        if (continuesFrom.current !== after) return;
        continuesFrom.current = page.nextCursor;
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
        if (continuesFrom.current !== after) return;
        setLoadingMore(false);
        setFailure(presentFailure(error));
      },
    );
  };

  /** Resolves true once the invitation is sent. */
  const invite = (input: {
    readonly email: string;
    readonly intendedRole: AssignableGlobalRole;
  }): Promise<boolean> => {
    setInvitePending(true);
    setInviteFailure(null);
    return inviteMember(input).then(
      () => {
        setInvitePending(false);
        onInvited(input.email);
        refresh();
        return true;
      },
      (error: unknown) => {
        setInvitePending(false);
        setInviteFailure(presentFailure(error));
        return false;
      },
    );
  };

  return {
    listing,
    failure,
    loadingMore,
    inviteFailure,
    invitePending,
    refresh,
    beginLoading,
    loadMore,
    invite,
  };
}
