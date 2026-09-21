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
import { StatusSection } from './InstallationSections.tsx';
import { classifyLoad } from './load-state.ts';

const ADMINISTRATION_SECTIONS = [
  { id: 'members', scope: 'top', label: () => translate('workspace.tab.members'), order: 10 },
  { id: 'status', scope: 'top', label: () => translate('workspace.tab.status'), order: 30 },
] as const satisfies readonly SectionTab[];

export interface AdministrationViewProps {
  readonly rooms: readonly MemberRoom[];
  readonly roomsComplete: boolean;
  readonly roomsLoadingMore: boolean;
  readonly onLoadMoreRooms: () => void;
  readonly sectionId: string;
  readonly onSectionChange: (sectionId: string) => void;
  readonly onStatus: (message: string) => void;
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
  });
  const { refresh, sessionEnded } = administration;

  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal);
    return () => {
      controller.abort();
    };
  }, [refresh]);

  useEffect(() => {
    if (sessionEnded) onStatus(translate('members.transfer.sessionEnded'));
  }, [sessionEnded, onStatus]);

  const sections = composeSections(ADMINISTRATION_SECTIONS, contributedSections('top'));
  const section = currentSection(sections, sectionId);
  const currentId = section?.id ?? '';

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
        label={translate('administration.sections.label')}
        sections={sections}
        currentId={currentId}
        onSelect={onSectionChange}
      />

      {currentId === 'members' ? (
        <MembersPanel
          subjects={listing.kind === 'ready' ? listing.value.subjects : []}
          busySubjectId={administration.busySubjectId}
          changeFailure={administration.changeFailure}
          listing={{
            loading: listing.kind === 'loading',
            denied: loadState.denied,
            failedLoad: loadState.failedLoad,
            loadRecovery: loadState.recovery,
            failure: administration.failure,
            /* The server's cursor, not a row count: a page bounded by the assignment
               budget can be short and still continue. */
            hasMore: listing.kind === 'ready' && listing.value.nextCursor !== null,
            loadingMore: administration.loadingMore,
            onLoadMore: administration.loadMore,
            onReload: () => {
              administration.beginLoading();
              administration.refresh();
            },
          }}
          invite={{
            pending: administration.invitePending,
            failure: administration.inviteFailure,
            onInvite: administration.invite,
          }}
          assignment={{
            rooms,
            roomsComplete,
            roomsLoadingMore,
            onLoadMoreRooms,
            onAssign: administration.assign,
          }}
          transfer={{
            impact: administration.transferImpact,
            impactPending: administration.transferImpactPending,
            pending: administration.transferPending,
            failure: administration.transferFailure,
            onReview: administration.reviewTransfer,
            onApply: administration.applyTransfer,
            onCancel: administration.cancelTransfer,
          }}
          onRevokeInvitation={administration.revokeInvitation}
          onRoleChange={administration.changeRole}
          onStateChange={administration.changeState}
          onSessionEnded={onSessionEnded}
        />
      ) : null}

      {currentId === 'status' ? <StatusSection /> : null}

      {section !== null && isContributed(section)
        ? section.render({ scope: 'top', onStatus })
        : null}
    </>
  );
}
