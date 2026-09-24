import { useId, useRef, useState } from 'react';
import type {
  AssignableGlobalRole,
  MemberRoom,
  MemberSubject,
  OwnershipTransferImpact,
  RoomAssignment,
} from '../api/client.ts';
import { translate } from '../i18n/translate.ts';
import { ConfirmationDialog } from './ConfirmationDialog.tsx';
import { isRoomAssignable, isTransferTarget } from '../workspace/administration.ts';
import type { PresentedFailure } from '../workspace/failures.ts';
import type { LoadRecovery } from '../workspace/views/load-state.ts';
import { MemberInviteForm } from './MemberInviteForm.tsx';
import { MemberRegister, type RoleChange, type StateChange } from './MemberRegister.tsx';
import { MemberRoomsDialog } from './MemberRoomsDialog.tsx';
import { Notice } from './Notice.tsx';
import { OwnershipTransferDialog } from './OwnershipTransferDialog.tsx';
export interface AssignmentChange {
  readonly memberId: string;
  readonly assign: readonly RoomAssignment[];
  readonly revoke: readonly string[];
}
export interface TransferApply {
  readonly memberId: string;
  readonly previewId: string;
  readonly expectedRevision: number;
  readonly confirmation: string;
}

/**
 * Grouped by the surface each prop belongs to, not flattened into one list.
 *
 * Thirty-odd sibling props named their own surface in a prefix -- `transferImpact`,
 * `transferPending`, `transferFailure`, `invitePending`, `inviteFailure` -- which is the
 * shape asking to be a group. Flat, every call site had to thread each one individually and
 * nothing said which belonged together, so a prop added for one dialog looked available to
 * all of them.
 *
 * The groups are the surfaces: the list, the invite form, the assignment dialog, the
 * transfer dialog. `subjects` and `busySubjectId` stay at the top level because they are
 * genuinely shared -- every surface here acts on a subject in that list.
 */
export interface MemberListingProps {
  readonly loading: boolean;
  readonly denied: boolean;
  readonly failedLoad: boolean;
  readonly loadRecovery: LoadRecovery;
  readonly failure: PresentedFailure | null;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly onLoadMore: () => void;
  readonly onReload: () => void;
}

export interface MemberInviteProps {
  readonly pending: boolean;
  readonly failure: PresentedFailure | null;
  readonly onInvite: (input: {
    readonly email: string;
    readonly intendedRole: AssignableGlobalRole;
  }) => void;
}

export interface MemberAssignmentProps {
  readonly rooms: readonly MemberRoom[];
  /** False when the register is a prefix, so the dialog can say so and offer the rest. */
  readonly roomsComplete: boolean;
  readonly roomsLoadingMore: boolean;
  readonly onLoadMoreRooms: () => void;
  /** `null` means the batch committed; a failure stays with the draft that caused it. */
  readonly onAssign: (input: AssignmentChange) => Promise<PresentedFailure | null>;
}

export interface MemberTransferProps {
  readonly impact: OwnershipTransferImpact | null;
  readonly impactPending: boolean;
  readonly pending: boolean;
  readonly failure: PresentedFailure | null;
  readonly onReview: (memberId: string) => void;
  readonly onApply: (input: TransferApply) => void;
  readonly onCancel: () => void;
}

export interface MembersPanelProps {
  readonly subjects: readonly MemberSubject[];
  /** The subject a row operation is running against, whichever surface started it. */
  readonly busySubjectId: string | null;
  readonly changeFailure: PresentedFailure | null;
  readonly listing: MemberListingProps;
  readonly invite: MemberInviteProps;
  readonly assignment: MemberAssignmentProps;
  readonly transfer: MemberTransferProps;
  readonly onRevokeInvitation: (invitationId: string) => void;
  readonly onRoleChange: (input: RoleChange) => Promise<PresentedFailure | null>;
  readonly onStateChange: (input: StateChange) => Promise<PresentedFailure | null>;
  readonly onSessionEnded: () => void;
}

/** A role or access change waiting for its one deliberate press. */
type PendingChange =
  | { readonly kind: 'role'; readonly change: RoleChange; readonly person: string }
  | { readonly kind: 'state'; readonly change: StateChange; readonly person: string };

function changeCopy(pending: PendingChange): {
  readonly title: string;
  readonly submit: string;
  readonly consequence: string;
} {
  const person = pending.person;
  if (pending.kind === 'role')
    return pending.change.role === 'admin'
      ? {
          title: translate('members.confirm.toAdmin.title', { person }),
          submit: translate('members.role.toAdmin'),
          consequence: translate('members.confirm.toAdmin.consequence'),
        }
      : {
          title: translate('members.confirm.toMember.title', { person }),
          submit: translate('members.role.toMember'),
          consequence: translate('members.confirm.toMember.consequence'),
        };
  return pending.change.state === 'disabled'
    ? {
        title: translate('members.confirm.disable.title', { person }),
        submit: translate('members.state.disable'),
        consequence: translate('members.state.disableWarning'),
      }
    : {
        title: translate('members.confirm.enable.title', { person }),
        submit: translate('members.state.enable'),
        consequence: translate('members.confirm.enable.consequence'),
      };
}

export function MembersPanel(props: MembersPanelProps): React.ReactElement {
  const headingId = useId();
  const [roomsFor, setRoomsFor] = useState<string | null>(null);
  const [transferFor, setTransferFor] = useState<string | null>(null);
  const roomsTrigger = useRef<HTMLButtonElement | null>(null);
  const [assignFailure, setAssignFailure] = useState<PresentedFailure | null>(null);
  const [pendingChange, setPendingChange] = useState<PendingChange | null>(null);

  const subjectById = (id: string | null): MemberSubject | null =>
    id === null ? null : (props.subjects.find((subject) => subject.subjectId === id) ?? null);
  const roomsCandidate = subjectById(roomsFor);
  const roomsSubject =
    roomsCandidate !== null && isRoomAssignable(roomsCandidate) ? roomsCandidate : null;
  const transferCandidate = subjectById(transferFor);
  const transferSubject =
    transferCandidate !== null && isTransferTarget(transferCandidate)
      ? transferCandidate
      : null;

  const assignPending = roomsSubject !== null && props.busySubjectId === roomsSubject.subjectId;

  const closeRooms = (): void => {
    setRoomsFor(null);
    setAssignFailure(null);
    roomsTrigger.current?.focus();
    roomsTrigger.current = null;
  };

  if (props.listing.loading)
    return (
      <section aria-labelledby={headingId}>
        <h2 className="df-section__heading" id={headingId}>
          {translate('members.title')}
        </h2>
        <p className="df-field__help">{translate('members.loading')}</p>
      </section>
    );

  if (props.listing.denied)
    return (
      <section aria-labelledby={headingId}>
        <h2 className="df-section__heading" id={headingId}>
          {translate('members.title')}
        </h2>
        <Notice tone="problem" role="alert">
          {translate('members.denied')}
        </Notice>
        <p className="df-field__help">{translate('members.deniedHelp')}</p>
      </section>
    );

  if (props.listing.failedLoad)
    return (
      <section aria-labelledby={headingId}>
        <h2 className="df-section__heading" id={headingId}>
          {translate('members.title')}
        </h2>
        <Notice
          tone="problem"
          role="alert"
          {...(props.listing.failure?.title === undefined ||
          props.listing.failure.title === null
            ? {}
            : { title: props.listing.failure.title })}
        >
          {props.listing.failure?.body ?? translate('members.failed')}
        </Notice>
        <div className="df-panel__actions">
          {props.listing.loadRecovery === 'sign-in' ? (
            <button
              type="button"
              className="df-button df-button--primary"
              onClick={props.onSessionEnded}
            >
              {translate('error.freshSignIn.action')}
            </button>
          ) : (
            <button type="button" className="df-button" onClick={props.listing.onReload}>
              {translate('members.failed.retry')}
            </button>
          )}
        </div>
      </section>
    );

  return (
    <section aria-labelledby={headingId}>
      <h2 className="df-section__heading" id={headingId}>
        {translate('members.title')}
      </h2>
      <p className="df-field__help">{translate('members.lead')}</p>

      {props.changeFailure === null ? null : (
        <Notice
          tone="problem"
          role="alert"
          {...(props.changeFailure.title === null ? {} : { title: props.changeFailure.title })}
        >
          {props.changeFailure.body}{' '}
          {props.changeFailure.offerReload ? (
            <button type="button" className="df-textlink" onClick={props.listing.onReload}>
              {translate('error.conflict.reload')}
            </button>
          ) : null}
        </Notice>
      )}

      {props.listing.failure === null ? null : (
        <Notice
          tone="problem"
          role="alert"
          {...(props.listing.failure.title === null
            ? {}
            : { title: props.listing.failure.title })}
        >
          {props.listing.failure.body}
        </Notice>
      )}

      <MemberRegister
        subjects={props.subjects}
        rooms={props.assignment.rooms}
        busySubjectId={props.busySubjectId}
        hasMore={props.listing.hasMore}
        loadingMore={props.listing.loadingMore}
        onRevokeInvitation={props.onRevokeInvitation}
        onRoleChange={(change, person) => {
          setPendingChange({ kind: 'role', change, person });
        }}
        onStateChange={(change, person) => {
          setPendingChange({ kind: 'state', change, person });
        }}
        onOpenRooms={(memberId, trigger) => {
          roomsTrigger.current = trigger;
          setRoomsFor(memberId);
        }}
        onOpenTransfer={(memberId) => {
          setTransferFor(memberId);
          props.transfer.onReview(memberId);
        }}
        onLoadMore={props.listing.onLoadMore}
      />

      <MemberInviteForm
        failure={props.invite.failure}
        pending={props.invite.pending}
        onInvite={props.invite.onInvite}
      />

      <MemberRoomsDialog
        open={roomsSubject !== null}
        subject={roomsSubject}
        rooms={props.assignment.rooms}
        roomsComplete={props.assignment.roomsComplete}
        roomsLoadingMore={props.assignment.roomsLoadingMore}
        onLoadMoreRooms={props.assignment.onLoadMoreRooms}
        pending={assignPending}
        failure={assignFailure}
        onApply={(input) => {
          setAssignFailure(null);
          /* The answer to THIS dialog's own batch. `void` because a dialog handler returns
             nothing; the outcome is consumed here rather than propagated. */
          void props.assignment.onAssign(input).then((failure) => {
            if (failure === null) closeRooms();
            else setAssignFailure(failure);
          });
        }}
        onClose={closeRooms}
      />

      <ConfirmationDialog
        open={pendingChange !== null}
        title={pendingChange === null ? '' : changeCopy(pendingChange).title}
        submitLabel={pendingChange === null ? '' : changeCopy(pendingChange).submit}
        pendingLabel={translate('members.confirm.pending')}
        content={
          pendingChange === null
            ? { kind: 'loading' }
            : {
                kind: 'ready',
                consequence: <p>{changeCopy(pendingChange).consequence}</p>,
                confirmation: {
                  phrase: null,
                  confirm: () =>
                    pendingChange.kind === 'role'
                      ? props.onRoleChange(pendingChange.change)
                      : props.onStateChange(pendingChange.change),
                },
              }
        }
        onClose={() => {
          setPendingChange(null);
        }}
        onReload={props.listing.onReload}
      />

      <OwnershipTransferDialog
        open={transferSubject !== null}
        subject={transferSubject}
        impact={props.transfer.impact}
        loading={props.transfer.impactPending}
        pending={props.transfer.pending}
        failure={props.transfer.failure}
        onConfirm={(confirmation) => {
          const impact = props.transfer.impact;
          if (impact === null || transferSubject === null) return;
          props.transfer.onApply({
            memberId: transferSubject.subjectId,
            previewId: impact.previewId,
            expectedRevision: impact.expectedRevision,
            confirmation,
          });
        }}
        onCancel={() => {
          setTransferFor(null);
          props.transfer.onCancel();
        }}
      />
    </section>
  );
}
