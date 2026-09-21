/**
 * Who inside the organization can reach Duefold, and which rooms they work in.
 *
 * Four properties are non-negotiable in this surface's construction, because each
 * is the difference between a true and a false statement about access:
 *
 * 1. AN INVITATION IS NOT A MEMBER. `member.state` admits `'invited'`, but
 *    acceptance inserts `'active'` directly, so an invited person exists only as an
 *    invitation and holds nothing. Their row says so in words and offers only
 *    withdrawal: no role, access, or room control can act on someone who has never
 *    signed in.
 * 2. A SHORT LIST IS NOT A COMPLETE ONE. Each subject carries its complete
 *    assignment set, but a page of SUBJECTS can be short and still continue. While
 *    a cursor remains this surface says the list is partial rather than letting a
 *    short table read as everyone.
 * 3. DENIED IS NOT EMPTY. A refusal renders the denied state and no table at all,
 *    so it neither confirms nor denies that members exist.
 * 4. EVERY STATE IS IN WORDS. Disabled, invited, and role-derived room access are
 *    all named; colour only reinforces.
 *
 * Nothing here is an authorization decision. The server refuses what it refuses,
 * and a control this surface offers is not a permission.
 */

import { useEffect, useId, useRef, useState } from 'react';
import type {
  AssignableGlobalRole,
  GlobalRole,
  MemberRoom,
  MemberState,
  MemberSubject,
  OwnershipTransferImpact,
  PendingInvitation,
  ProvisionedMember,
  RoomAssignment,
} from '../api/client.ts';
import { translate, type MessageKey } from '../i18n/translate.ts';
import {
  assignmentFailureBelongsTo,
  isAdministrable,
  isRoomAssignable,
} from '../workspace/administration.ts';
import type { PresentedFailure } from '../workspace/failures.ts';
import type { ChangeFailureOrigin } from '../workspace/useAdministrationSection.ts';
import type { LoadRecovery } from '../workspace/views/load-state.ts';
import { Notice } from './Notice.tsx';
import { MemberRoomsDialog } from './MemberRoomsDialog.tsx';
import { OwnershipTransferDialog } from './OwnershipTransferDialog.tsx';

const ROLE_LABEL: Readonly<Record<GlobalRole, MessageKey>> = {
  owner: 'members.role.owner',
  admin: 'members.role.admin',
  member: 'members.role.member',
};
const ROLE_EXPLAIN: Readonly<Record<GlobalRole, MessageKey>> = {
  owner: 'members.role.owner.explain',
  admin: 'members.role.admin.explain',
  member: 'members.role.member.explain',
};
const STATE_LABEL: Readonly<Record<MemberState, MessageKey>> = {
  active: 'members.state.active',
  disabled: 'members.state.disabled',
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export interface RoleChange {
  readonly memberId: string;
  readonly role: AssignableGlobalRole;
  readonly expectedRevision: number;
}
export interface StateChange {
  readonly memberId: string;
  readonly state: MemberState;
  readonly expectedRevision: number;
}
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

export interface MembersPanelProps {
  readonly subjects: readonly MemberSubject[];
  /** Rooms a member can be staffed into. */
  readonly rooms: readonly MemberRoom[];
  /** Whether `rooms` is the whole register; see `MemberRoomsDialog`. */
  readonly roomsComplete: boolean;
  /** True while a further page of the register is being read. */
  readonly roomsLoadingMore: boolean;
  /** Reads the next page of the register, so staffing is not confined to the first. */
  readonly onLoadMoreRooms: () => void;
  /** True while the first page loads. */
  readonly loading: boolean;
  /**
   * True only when the server REFUSED the reader.
   *
   * Distinct from `failedLoad`: a denial is terminal and discloses nothing, while a
   * failure names its own cause and offers a retry. Collapsing the two reported every
   * offline or expired-session load as an authorization decision.
   */
  readonly denied: boolean;
  /** True when the first page failed for any non-denial reason. */
  readonly failedLoad: boolean;
  /**
   * Which recovery the failed load earns, decided by `classifyLoad`.
   *
   * Passed in rather than derived here so the copy and the control cannot disagree: a
   * stale-authentication refusal read "this change needs a fresh sign-in" above a button
   * labelled "Load members again", so the only offered action reproduced the refusal and
   * the member could not reach the instruction they had just been given.
   */
  readonly loadRecovery: LoadRecovery;
  readonly failure: PresentedFailure | null;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly inviteFailure: PresentedFailure | null;
  readonly invitePending: boolean;
  readonly busySubjectId: string | null;
  readonly changeFailure: PresentedFailure | null;
  /**
   * Which operation `changeFailure` came from.
   *
   * The failure field is shared by role, state, invitation and assignment operations, so
   * the assignment dialog needs this to know whether the failure is its own. Without it the
   * dialog showed whatever was last reported: after any failed row mutation, opening room
   * assignment displayed that unrelated error as if it belonged to the new draft.
   */
  readonly changeFailureOrigin: ChangeFailureOrigin | null;
  readonly transferImpact: OwnershipTransferImpact | null;
  readonly transferImpactPending: boolean;
  readonly transferPending: boolean;
  readonly transferFailure: PresentedFailure | null;
  /**
   * Confirmed assignment batches, counted by the hook that owns the request.
   *
   * The dialog closes when this ADVANCES and at no other time. It must stay open through
   * pending and through a refusal so the draft survives, and "success" cannot be inferred
   * from the busy subject clearing: a refused batch clears it too, and the failure state
   * may not have landed in the same render.
   */
  readonly assignmentsApplied: number;
  readonly onInvite: (input: {
    readonly email: string;
    readonly intendedRole: AssignableGlobalRole;
  }) => void;
  readonly onRevokeInvitation: (invitationId: string) => void;
  readonly onRoleChange: (input: RoleChange) => void;
  readonly onStateChange: (input: StateChange) => void;
  readonly onAssign: (input: AssignmentChange) => void;
  readonly onReviewTransfer: (memberId: string) => void;
  readonly onApplyTransfer: (input: TransferApply) => void;
  readonly onCancelTransfer: () => void;
  readonly onLoadMore: () => void;
  readonly onReload: () => void;
  /** Recovery for a load that failed because this session has ended. */
  readonly onSessionEnded: () => void;
}

export function MembersPanel(props: MembersPanelProps): React.ReactElement {
  const headingId = useId();
  const inviteId = useId();
  const [email, setEmail] = useState('');
  const [emailAttempted, setEmailAttempted] = useState(false);
  const [inviteRole, setInviteRole] = useState<AssignableGlobalRole>('member');
  const [roomsFor, setRoomsFor] = useState<string | null>(null);
  const [transferFor, setTransferFor] = useState<string | null>(null);
  /*
   * The control that opened the assignment dialog, so focus returns to the row it acted
   * on rather than to the document. Base UI returns focus to whatever was focused before
   * the dialog opened, which is correct for a manual dismissal; a programmatic close on
   * success happens while focus is inside a popup that is being unmounted, so the element
   * is named explicitly. The transfer dialog needs none: it closes only through cancel or
   * into the terminal session-ended surface, neither of which returns to a row.
   */
  const roomsTrigger = useRef<HTMLButtonElement | null>(null);
  /* The applied count at the moment this dialog opened. A later value means a batch
     committed for it, which is the only thing that closes it. */
  const appliedWhenOpened = useRef(props.assignmentsApplied);

  const emailValid = EMAIL.test(email.trim());
  const subjectById = (id: string | null): MemberSubject | null =>
    id === null ? null : (props.subjects.find((subject) => subject.subjectId === id) ?? null);
  /*
   * Both dialogs act on a PROVISIONED member. Resolving through the type guards rather
   * than casting means a refreshed page that turned a row into something ineligible
   * closes the dialog instead of leaving it open over a subject it cannot act on.
   */
  const roomsCandidate = subjectById(roomsFor);
  const roomsSubject =
    roomsCandidate !== null && isRoomAssignable(roomsCandidate) ? roomsCandidate : null;
  const transferCandidate = subjectById(transferFor);
  const transferSubject =
    transferCandidate !== null && isAdministrable(transferCandidate) ? transferCandidate : null;

  /*
   * This member's batch is in flight. Derived from the busy subject rather than held
   * locally, so it cannot disagree with the hook that actually owns the request.
   */
  const assignPending = roomsSubject !== null && props.busySubjectId === roomsSubject.subjectId;

  /*
   * CLOSED ONLY BY A CONFIRMED BATCH.
   *
   * The dialog previously closed on submit, in the same render that started the request,
   * so its pending label and dismissal suppression could never be observed and a refusal
   * dropped the administrator back to the table having discarded a multi-room draft. It
   * now stays mounted through pending and through failure, and this effect closes it when
   * the hook reports one more applied batch than when it opened.
   */
  useEffect(() => {
    if (roomsFor === null) {
      appliedWhenOpened.current = props.assignmentsApplied;
      return;
    }
    if (props.assignmentsApplied === appliedWhenOpened.current) return;
    setRoomsFor(null);
    /* Focus returns to the control that opened it. A programmatic close unmounts the
       popup while focus is inside it, so without this focus would land on the document
       and a keyboard user would restart from the top of the page. */
    roomsTrigger.current?.focus();
    roomsTrigger.current = null;
  }, [roomsFor, props.assignmentsApplied]);

  if (props.loading)
    return (
      <section aria-labelledby={headingId}>
        <h2 className="df-section__heading" id={headingId}>
          {translate('members.title')}
        </h2>
        <p className="df-field__help">{translate('members.loading')}</p>
      </section>
    );

  /*
   * A REFUSAL renders no table and no invite form, and its copy says only that the
   * surface is unavailable to this role. Whether members exist is not disclosed: the
   * server answers a denial uniformly and this surface does not undo that. There is
   * deliberately no retry, because retrying a refusal would only be refused again.
   */
  if (props.denied)
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

  /*
   * A FAILED load, which is not a refusal.
   *
   * Every failure class used to arrive here as "not available to your role": an offline
   * browser, an ended session, a malformed response, and a server fault all claimed an
   * authorization cause they did not have, named the wrong recovery, and offered none.
   * The failure's own designed copy is shown instead, with the retry that class earns.
   */
  if (props.failedLoad)
    return (
      <section aria-labelledby={headingId}>
        <h2 className="df-section__heading" id={headingId}>
          {translate('members.title')}
        </h2>
        <Notice
          tone="problem"
          role="alert"
          {...(props.failure?.title === undefined || props.failure.title === null
            ? {}
            : { title: props.failure.title })}
        >
          {props.failure?.body ?? translate('members.failed')}
        </Notice>
        <div className="df-panel__actions">
          {/*
           * The recovery the failure CLASS earns, decided in one place.
           *
           * An ended session and a stale-authentication refusal both earn SIGN-IN: neither
           * can succeed on this session, so a reload button would be an action that cannot
           * work, and for the stale-authentication case it also contradicted copy that had
           * just told the member to sign in again. Every other class earns the retry,
           * because the request may well succeed unchanged once the connection or the
           * server recovers.
           */}
          {props.loadRecovery === 'sign-in' ? (
            <button
              type="button"
              className="df-button df-button--primary"
              onClick={props.onSessionEnded}
            >
              {translate('error.freshSignIn.action')}
            </button>
          ) : (
            <button type="button" className="df-button" onClick={props.onReload}>
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
            <button type="button" className="df-textlink" onClick={props.onReload}>
              {translate('error.conflict.reload')}
            </button>
          ) : null}
        </Notice>
      )}

      {/* A further page failed while the pages already read stay on screen. Those
          are complete for the subjects they name, so they are kept and the refusal
          says the rest is unread. */}
      {props.failure === null ? null : (
        <Notice
          tone="problem"
          role="alert"
          {...(props.failure.title === null ? {} : { title: props.failure.title })}
        >
          {props.failure.body}
        </Notice>
      )}

      {props.subjects.length === 0 ? (
        <div className="df-empty">
          <span className="df-empty__lead">{translate('members.empty')}</span>
          {translate('members.emptyHelp')}
        </div>
      ) : (
        <>
          {/* Stated once, above the controls that cause it, rather than repeated on
              every row: a role, access, or room change ends that member's sessions,
              and they learn about it by being signed out. */}
          <Notice tone="caution">{translate('members.role.signOutWarning')}</Notice>

          <table className="df-register">
            <caption className="df-visually-hidden">{translate('members.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{translate('members.columns.person')}</th>
                <th scope="col">{translate('members.columns.role')}</th>
                <th scope="col">{translate('members.columns.state')}</th>
                <th scope="col">{translate('members.columns.rooms')}</th>
                <th scope="col">
                  <span className="df-visually-hidden">
                    {translate('members.columns.actions')}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {props.subjects.map((subject) =>
                /*
                 * Dispatched on kind rather than handed to one row that branches
                 * internally. The two kinds describe different things — a role held
                 * versus a role promised, rooms versus no member row at all — and
                 * keeping them apart means neither can read a field the other owns.
                 */
                subject.subjectKind === 'invitation' ? (
                  <InvitationRow
                    key={subject.subjectId}
                    subject={subject}
                    busy={props.busySubjectId === subject.subjectId}
                    anyBusy={props.busySubjectId !== null}
                    onRevokeInvitation={props.onRevokeInvitation}
                  />
                ) : (
                  <MemberRow
                    key={subject.subjectId}
                    subject={subject}
                    rooms={props.rooms}
                    busy={props.busySubjectId === subject.subjectId}
                    anyBusy={props.busySubjectId !== null}
                    onRoleChange={props.onRoleChange}
                    onStateChange={props.onStateChange}
                    onOpenRooms={(trigger) => {
                      roomsTrigger.current = trigger;
                      appliedWhenOpened.current = props.assignmentsApplied;
                      setRoomsFor(subject.subjectId);
                    }}
                    onOpenTransfer={() => {
                      setTransferFor(subject.subjectId);
                      props.onReviewTransfer(subject.subjectId);
                    }}
                  />
                ),
              )}
            </tbody>
          </table>

          {props.hasMore ? (
            <>
              <p className="df-field__help">{translate('members.page.partial')}</p>
              <div className="df-panel__actions">
                <button
                  type="button"
                  className="df-button"
                  data-busy={props.loadingMore ? 'true' : 'false'}
                  disabled={props.loadingMore}
                  onClick={props.onLoadMore}
                >
                  {props.loadingMore
                    ? translate('members.page.loadingMore')
                    : translate('members.page.more')}
                </button>
              </div>
            </>
          ) : null}
        </>
      )}

      <div className="df-panel__block">
        <h3 className="df-panel__subheading">{translate('members.invite')}</h3>
        <p className="df-field__help">{translate('members.invite.note')}</p>
        {props.inviteFailure === null ? null : (
          <Notice
            tone="problem"
            role="alert"
            {...(props.inviteFailure.title === null
              ? {}
              : { title: props.inviteFailure.title })}
          >
            {props.inviteFailure.body}
          </Notice>
        )}
        <div className="df-field">
          <label className="df-field__label" htmlFor={`${inviteId}-email`}>
            {translate('members.invite.email')}
          </label>
          <input
            id={`${inviteId}-email`}
            className="df-field__input"
            type="email"
            autoComplete="email"
            value={email}
            disabled={props.invitePending}
            aria-invalid={emailAttempted && !emailValid ? 'true' : undefined}
            aria-describedby={
              emailAttempted && !emailValid ? `${inviteId}-error` : `${inviteId}-help`
            }
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
          <p className="df-field__help" id={`${inviteId}-help`}>
            {translate('members.invite.emailHelp')}
          </p>
          {emailAttempted && !emailValid ? (
            <p className="df-field__error" id={`${inviteId}-error`} role="alert">
              {translate('members.invite.invalid')}
            </p>
          ) : null}
        </div>
        <div className="df-field">
          <label className="df-field__label" htmlFor={`${inviteId}-role`}>
            {translate('members.invite.role')}
          </label>
          <select
            id={`${inviteId}-role`}
            className="df-field__input"
            value={inviteRole}
            disabled={props.invitePending}
            aria-describedby={`${inviteId}-role-help`}
            onChange={(event) => {
              setInviteRole(event.target.value === 'admin' ? 'admin' : 'member');
            }}
          >
            <option value="member">{translate('members.role.member')}</option>
            <option value="admin">{translate('members.role.admin')}</option>
          </select>
          {/* The chosen role's consequence, stated as it is chosen rather than
              discovered when the invitee arrives holding more than expected. */}
          <p className="df-field__help" id={`${inviteId}-role-help`}>
            {translate(ROLE_EXPLAIN[inviteRole])}
          </p>
        </div>
        <div className="df-panel__actions">
          <button
            type="button"
            className="df-button df-button--primary"
            data-busy={props.invitePending ? 'true' : 'false'}
            disabled={props.invitePending}
            onClick={() => {
              setEmailAttempted(true);
              if (!EMAIL.test(email.trim())) return;
              props.onInvite({ email: email.trim(), intendedRole: inviteRole });
              setEmail('');
              setEmailAttempted(false);
            }}
          >
            {props.invitePending
              ? translate('members.invite.pending')
              : translate('members.invite.submit')}
          </button>
        </div>
      </div>

      {/*
       * The dialog stays open until the batch RESOLVES.
       *
       * Closing it on submit unmounted it in the same render that started the request,
       * so its pending label, focus containment, and dismissal suppression could never
       * be observed, and a refusal dropped the administrator back to the table having
       * discarded a multi-room draft. It now closes only on a CONFIRMED batch, reported
       * by the hook that owns the request, and focus returns to the row control.
       */}
      <MemberRoomsDialog
        open={roomsSubject !== null}
        subject={roomsSubject}
        rooms={props.rooms}
        roomsComplete={props.roomsComplete}
        roomsLoadingMore={props.roomsLoadingMore}
        onLoadMoreRooms={props.onLoadMoreRooms}
        pending={assignPending}
        /*
         * ONLY THIS MEMBER'S OWN ASSIGNMENT FAILURE.
         *
         * The failure field is shared across row operations, so passing it through
         * unconditionally showed a failed role or state change — possibly for a different
         * person — inside a freshly opened assignment dialog, as though the draft on screen
         * had been rejected. Matching the origin keeps a real assignment failure visible
         * across a retry while refusing to adopt anyone else's.
         */
        failure={
          assignmentFailureBelongsTo(props.changeFailureOrigin, roomsSubject?.subjectId ?? null)
            ? props.changeFailure
            : null
        }
        onApply={props.onAssign}
        onClose={() => {
          setRoomsFor(null);
          roomsTrigger.current = null;
        }}
      />

      <OwnershipTransferDialog
        open={transferSubject !== null}
        subject={transferSubject}
        impact={props.transferImpact}
        loading={props.transferImpactPending}
        pending={props.transferPending}
        failure={props.transferFailure}
        onConfirm={(confirmation) => {
          const impact = props.transferImpact;
          if (impact === null || transferSubject === null) return;
          props.onApplyTransfer({
            memberId: transferSubject.subjectId,
            previewId: impact.previewId,
            expectedRevision: impact.expectedRevision,
            confirmation,
          });
        }}
        onCancel={() => {
          setTransferFor(null);
          props.onCancelTransfer();
        }}
      />
    </section>
  );
}

/**
 * One table cell, carrying its column's name for the stacked layout.
 *
 * At narrow widths the stylesheet block-stacks every cell, so a cell showing only its
 * value would be an unlabelled string of text and an unexplained button. `data-label`
 * supplies the column name, which the stylesheet renders as generated content in that
 * layout only.
 *
 * The label is presentational on purpose: the real `<th scope="col">` headers stay in
 * the DOM — visually hidden, never `display:none`, which can drop the header
 * association — so the programmatic relationship is intact and a rendered label element
 * would only make every value announce twice.
 */
function Cell({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return <td data-label={label}>{children}</td>;
}

interface RowProps {
  readonly busy: boolean;
  readonly anyBusy: boolean;
}

/**
 * A pending invitation.
 *
 * Its own component, not a branch inside the member row. An invitation has no role it
 * holds, no state but pending, and no rooms — it names someone who has never signed in
 * — so the only control is withdrawal. Expressing that as a separate row makes it
 * structural: there is no `globalRole` or `assignments` in scope to read by accident,
 * and the type refuses any attempt to.
 */
function InvitationRow({
  subject,
  busy,
  anyBusy,
  onRevokeInvitation,
}: RowProps & {
  readonly subject: PendingInvitation;
  readonly onRevokeInvitation: (invitationId: string) => void;
}): React.ReactElement {
  return (
    <tr data-subject="invitation" data-state="pending">
      <th
        scope="row"
        className="df-register__name"
        data-label={translate('members.columns.person')}
      >
        {subject.emailDisplay}
      </th>
      <Cell label={translate('members.columns.role')}>
        {/* The role on ARRIVAL, not one they hold. The distinction is the difference
            between describing a future grant and claiming a present one. */}
        <span className="df-state">{translate(ROLE_LABEL[subject.intendedRole])}</span>
        <span className="df-register__meta">
          {translate('members.role.intended', {
            role: translate(ROLE_LABEL[subject.intendedRole]),
          })}
        </span>
      </Cell>
      <Cell label={translate('members.columns.state')}>
        <span className="df-state" data-live="false">
          {translate('members.state.invited')}
        </span>
        <span className="df-register__meta">{translate('members.state.invitedHelp')}</span>
      </Cell>
      <Cell label={translate('members.columns.rooms')}>
        <span className="df-register__meta">{translate('members.rooms.none')}</span>
      </Cell>
      <Cell label={translate('members.columns.actions')}>
        <div className="df-register__actions">
          <button
            type="button"
            className="df-button df-button--quiet"
            data-busy={busy ? 'true' : 'false'}
            disabled={anyBusy}
            onClick={() => {
              onRevokeInvitation(subject.subjectId);
            }}
          >
            {translate('members.invite.revoke')}
            <span className="df-visually-hidden"> {subject.emailDisplay}</span>
          </button>
        </div>
      </Cell>
    </tr>
  );
}

/**
 * A provisioned member.
 *
 * The Owner carries no role or access control. Ownership moves only through the audited
 * transfer, and the Owner cannot be disabled, so offering either would present an action
 * the server refuses. Only a plain active Member is staffed into rooms: an Owner or
 * Admin already holds Room Manager authority everywhere, so an assignment row for them
 * would advertise a narrower role than they keep.
 */
function MemberRow({
  subject,
  rooms,
  busy,
  anyBusy,
  onRoleChange,
  onStateChange,
  onOpenRooms,
  onOpenTransfer,
}: RowProps & {
  readonly subject: ProvisionedMember;
  readonly rooms: readonly MemberRoom[];
  readonly onRoleChange: (input: RoleChange) => void;
  readonly onStateChange: (input: StateChange) => void;
  /** Carries the pressed control so focus can return to it after a programmatic close. */
  readonly onOpenRooms: (trigger: HTMLButtonElement) => void;
  readonly onOpenTransfer: () => void;
}): React.ReactElement {
  const assignable = isRoomAssignable(subject);
  const administrable = isAdministrable(subject);
  const byRole = subject.globalRole !== 'member';

  return (
    <tr data-subject="member" data-state={subject.state}>
      <th
        scope="row"
        className="df-register__name"
        data-label={translate('members.columns.person')}
      >
        {subject.emailDisplay}
      </th>
      <Cell label={translate('members.columns.role')}>
        <span className="df-state">{translate(ROLE_LABEL[subject.globalRole])}</span>
        <span className="df-register__meta">{translate(ROLE_EXPLAIN[subject.globalRole])}</span>
      </Cell>
      <Cell label={translate('members.columns.state')}>
        {/* Named in words; `data-live` only reinforces what the words already say. */}
        <span className="df-state" data-live={subject.state === 'active' ? 'true' : 'false'}>
          {translate(STATE_LABEL[subject.state])}
        </span>
        {subject.state === 'disabled' ? (
          <span className="df-register__meta">{translate('members.state.disabledHelp')}</span>
        ) : null}
      </Cell>
      <Cell label={translate('members.columns.rooms')}>
        {byRole ? (
          <>
            <span className="df-register__meta">{translate('members.rooms.byRole')}</span>
            {/* Why an administrator has no staffing control, rather than leaving its
                absence to be read as an oversight. */}
            <span className="df-register__meta">{translate('members.assign.onlyMembers')}</span>
          </>
        ) : subject.assignments.length === 0 ? (
          <span className="df-register__meta">{translate('members.rooms.none')}</span>
        ) : (
          <ul className="df-grants">
            {subject.assignments.map((assignment) => {
              /*
               * A room the register has not loaded is still LISTED, named by its role
               * and marked as outside the loaded register. Omitting it would understate
               * this member's access, which is the one thing this cell must never do.
               */
              const room = rooms.find((entry) => entry.roomId === assignment.roomId) ?? null;
              return (
                <li key={assignment.roomId}>
                  <span className="df-grants__target">
                    {room?.title ?? translate('members.rooms.unknown')}
                  </span>
                  <span className="df-register__meta">
                    {translate(
                      assignment.roomRole === 'manager'
                        ? 'members.assign.manager'
                        : 'members.assign.contributor',
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Cell>
      <Cell label={translate('members.columns.actions')}>
        <div className="df-register__actions">
          {assignable ? (
            <button
              type="button"
              className="df-button df-button--quiet"
              disabled={anyBusy}
              onClick={(event) => {
                onOpenRooms(event.currentTarget);
              }}
            >
              {translate('members.rooms.manage')}
              <span className="df-visually-hidden"> {subject.emailDisplay}</span>
            </button>
          ) : null}

          {administrable ? (
            <>
              <button
                type="button"
                className="df-button df-button--quiet"
                data-busy={busy ? 'true' : 'false'}
                disabled={anyBusy}
                onClick={() => {
                  onRoleChange({
                    memberId: subject.subjectId,
                    role: subject.globalRole === 'admin' ? 'member' : 'admin',
                    expectedRevision: subject.revision,
                  });
                }}
              >
                {translate(
                  subject.globalRole === 'admin'
                    ? 'members.role.toMember'
                    : 'members.role.toAdmin',
                )}
                <span className="df-visually-hidden"> {subject.emailDisplay}</span>
              </button>
              <button
                type="button"
                className="df-button df-button--quiet"
                data-busy={busy ? 'true' : 'false'}
                disabled={anyBusy}
                onClick={() => {
                  onStateChange({
                    memberId: subject.subjectId,
                    state: subject.state === 'disabled' ? 'active' : 'disabled',
                    expectedRevision: subject.revision,
                  });
                }}
              >
                {translate(
                  subject.state === 'disabled'
                    ? 'members.state.enable'
                    : 'members.state.disable',
                )}
                <span className="df-visually-hidden"> {subject.emailDisplay}</span>
              </button>
              {subject.state === 'active' ? (
                <button
                  type="button"
                  className="df-button df-button--quiet"
                  disabled={anyBusy}
                  onClick={onOpenTransfer}
                >
                  {translate('members.transfer')}
                  <span className="df-visually-hidden"> {subject.emailDisplay}</span>
                </button>
              ) : null}
            </>
          ) : null}
        </div>
        {/*
         * What the two offered changes will do, stated beside the controls that do
         * them. These act immediately — there is no dialog to carry the warning — so
         * without this the promotion's assignment revocation and the disable's
         * immediate sign-out would both be discovered afterwards.
         */}
        {administrable ? (
          <>
            {subject.globalRole === 'member' && subject.assignments.length > 0 ? (
              <span className="df-register__meta">
                {translate('members.role.supersedesWarning')}
              </span>
            ) : null}
            {subject.state === 'active' ? (
              <span className="df-register__meta">
                {translate('members.state.disableWarning')}
              </span>
            ) : null}
          </>
        ) : null}
      </Cell>
    </tr>
  );
}
