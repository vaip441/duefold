import { useCallback, useState } from 'react';
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

  const loadMore = (): void => {
    if (listing.kind !== 'ready' || listing.value.nextCursor === null) return;
    setLoadingMore(true);
    setFailure(null);
    loadMembers({ after: listing.value.nextCursor }).then(
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
        setFailure(presentFailure(error));
      },
    );
  };

  const invite = (input: {
    readonly email: string;
    readonly intendedRole: AssignableGlobalRole;
  }): void => {
    setInvitePending(true);
    setInviteFailure(null);
    inviteMember(input).then(
      () => {
        setInvitePending(false);
        onInvited(input.email);
        refresh();
      },
      (error: unknown) => {
        setInvitePending(false);
        setInviteFailure(presentFailure(error));
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
