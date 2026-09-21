/**
 * The organization workbench: Members today, further sections later.
 *
 * Section tabs are composed rather than literal, so this view uses the same strip
 * grammar as a room. Members is the only section for now, and a strip of one tab is
 * suppressed: it would cost a tab stop and say nothing.
 *
 * The session-ended state is the notable one. `transfer-apply` revokes the acting
 * Owner's sessions inside its own transaction, so the request that succeeded
 * destroyed the session that made it. This view renders that as a completed transfer
 * plus a sign-out, NOT as an authentication error, and the surface is terminal: no
 * reload is attempted, because it could only produce a 401 the member would have to
 * interpret a second time.
 */

import { useEffect } from 'react';
import type { MemberRoom } from '../../api/client.ts';
import { MembersPanel } from '../../components/MembersPanel.tsx';
import { Notice } from '../../components/Notice.tsx';
import { SectionNav } from '../../components/SectionNav.tsx';
import type { SectionTab } from '../../contract.ts';
import { translate } from '../../i18n/translate.ts';
import {
  composeSections,
  contributedSections,
  currentSection,
  isContributed,
} from '../sections.ts';
import { useAdministrationSection } from '../useAdministrationSection.ts';
import { classifyLoad } from './load-state.ts';

export interface AdministrationViewProps {
  readonly rooms: readonly MemberRoom[];
  /**
   * Whether `rooms` is the WHOLE register.
   *
   * The register is paged, so a prefix presented as the full set would let a room the
   * administrator never received read as a room this member is not staffed into. The
   * staffing dialog says so rather than claiming an answer about rooms it cannot see.
   */
  readonly roomsComplete: boolean;
  /** True while a further page of the register is being read. */
  readonly roomsLoadingMore: boolean;
  /** Reads the next page of the register, so staffing is not confined to the first. */
  readonly onLoadMoreRooms: () => void;
  readonly sectionId: string;
  readonly onSectionChange: (sectionId: string) => void;
  readonly onStatus: (message: string) => void;
  /** Ends the frame's session state after a transfer signed this Owner out. */
  readonly onSessionEnded: () => void;
}

export function AdministrationView({
  rooms,
  roomsComplete,
  roomsLoadingMore,
  onLoadMoreRooms,
  sectionId,
  onSectionChange,
  onStatus,
  onSessionEnded,
}: AdministrationViewProps): React.ReactElement {
  const administration = useAdministrationSection({
    onInvited: () => {
      onStatus(translate('members.invite.sent'));
    },
    onInvitationRevoked: () => {
      onStatus(translate('members.invite.revoked'));
    },
    onRoleChanged: () => {
      onStatus(translate('members.role.changed'));
    },
    onStateChanged: () => {
      onStatus(translate('members.state.changed'));
    },
    onAssigned: () => {
      onStatus(translate('members.assign.saved'));
    },
    onTransferred: () => {
      onStatus(translate('members.transfer.sessionEnded'));
    },
  });
  const { refresh, sessionEnded } = administration;

  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal);
    return () => {
      controller.abort();
    };
  }, [refresh]);

  /* Announced through the frame's one polite live region: the visible surface below
     changes wholesale, which a screen-reader user would otherwise not be told. */
  useEffect(() => {
    if (sessionEnded) onStatus(translate('members.transfer.sessionEnded'));
  }, [sessionEnded, onStatus]);

  const sections = composeSections(
    [
      {
        id: 'members',
        scope: 'top',
        label: () => translate('workspace.tab.members'),
        order: 10,
      },
    ] as const satisfies readonly SectionTab[],
    contributedSections('top'),
  );
  const section = currentSection(sections, sectionId);
  const currentId = section?.id ?? '';

  /*
   * Terminal and successful. The transfer completed; this session did not survive
   * it. The copy states both facts, and the only action is to sign in again.
   */
  if (sessionEnded)
    return (
      <>
        <Notice tone="action" role="status">
          {translate('members.transfer.sessionEnded')}
        </Notice>
        <div className="df-panel__actions">
          <button
            type="button"
            className="df-button df-button--primary"
            onClick={onSessionEnded}
          >
            {translate('members.transfer.signInAgain')}
          </button>
        </div>
      </>
    );

  const listing = administration.listing;
  const loadState = classifyLoad({
    failed: listing.kind === 'failed',
    failure: administration.failure,
  });

  return (
    <>
      <SectionNav
        label={translate('workspace.views.label')}
        sections={sections}
        currentId={currentId}
        onSelect={onSectionChange}
      />

      {currentId === 'members' ? (
        <MembersPanel
          subjects={listing.kind === 'ready' ? listing.value.subjects : []}
          rooms={rooms}
          roomsComplete={roomsComplete}
          roomsLoadingMore={roomsLoadingMore}
          onLoadMoreRooms={onLoadMoreRooms}
          loading={listing.kind === 'loading'}
          /*
           * DENIED is the server's refusal, and nothing else is. The rule lives in
           * `classifyLoad` so it is one definition with its own tests; mapping every
           * failure to a denial here reported an offline browser, an ended session, a
           * malformed response, and a server fault as authorization decisions.
           */
          denied={loadState.denied}
          failedLoad={loadState.failedLoad}
          loadRecovery={loadState.recovery}
          failure={administration.failure}
          hasMore={listing.kind === 'ready' && listing.value.nextCursor !== null}
          loadingMore={administration.loadingMore}
          inviteFailure={administration.inviteFailure}
          invitePending={administration.invitePending}
          busySubjectId={administration.busySubjectId}
          changeFailure={administration.changeFailure}
          changeFailureOrigin={administration.changeFailureOrigin}
          transferImpact={administration.transferImpact}
          transferImpactPending={administration.transferImpactPending}
          transferPending={administration.transferPending}
          transferFailure={administration.transferFailure}
          assignmentsApplied={administration.assignmentsApplied}
          onInvite={administration.invite}
          onRevokeInvitation={administration.revokeInvitation}
          onRoleChange={administration.changeRole}
          onStateChange={administration.changeState}
          onAssign={administration.assign}
          onReviewTransfer={administration.reviewTransfer}
          onApplyTransfer={administration.applyTransfer}
          onCancelTransfer={administration.cancelTransfer}
          onLoadMore={administration.loadMore}
          onReload={() => {
            administration.beginLoading();
            administration.refresh();
          }}
          onSessionEnded={onSessionEnded}
        />
      ) : null}

      {section !== null && isContributed(section)
        ? section.render({ roomId: null, onStatus })
        : null}
    </>
  );
}
