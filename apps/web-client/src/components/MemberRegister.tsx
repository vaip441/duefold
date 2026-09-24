import type {
  AssignableGlobalRole,
  GlobalRole,
  MemberRoom,
  MemberState,
  MemberSubject,
  PendingInvitation,
  ProvisionedMember,
} from '../api/client.ts';
import { translate, type MessageKey } from '../i18n/translate.ts';
import { isRoomAssignable, isTransferTarget } from '../workspace/administration.ts';

const ROLE_LABEL: Readonly<Record<GlobalRole, MessageKey>> = {
  owner: 'members.role.owner',
  admin: 'members.role.admin',
  member: 'members.role.member',
};
const STATE_LABEL: Readonly<Record<MemberState, MessageKey>> = {
  active: 'members.state.active',
  disabled: 'members.state.disabled',
};

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

export interface MemberRegisterProps {
  readonly subjects: readonly MemberSubject[];
  readonly rooms: readonly MemberRoom[];
  readonly busySubjectId: string | null;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly onRevokeInvitation: (invitationId: string) => void;
  /** The person's address travels with the change so the confirmation can name them. */
  readonly onRoleChange: (input: RoleChange, person: string) => void;
  readonly onStateChange: (input: StateChange, person: string) => void;
  readonly onOpenRooms: (memberId: string, trigger: HTMLButtonElement) => void;
  readonly onOpenTransfer: (memberId: string) => void;
  readonly onLoadMore: () => void;
}

export function MemberRegister(props: MemberRegisterProps): React.ReactElement {
  if (props.subjects.length === 0)
    return (
      <div className="df-empty">
        <span className="df-empty__lead">{translate('members.empty')}</span>
        {translate('members.emptyHelp')}
      </div>
    );

  return (
    <>
      <dl className="df-legend">
        {(['owner', 'admin', 'member'] as const).map((role) => (
          <div key={role} className="df-legend__item">
            <dt>{translate(ROLE_LABEL[role])}</dt>
            <dd>{translate(`members.role.${role}.explain`)}</dd>
          </div>
        ))}
      </dl>
      <p className="df-field__help">{translate('members.role.signOutWarning')}</p>
      <table className="df-register">
        <caption className="df-visually-hidden">{translate('members.title')}</caption>
        <thead>
          <tr>
            <th scope="col">{translate('members.columns.person')}</th>
            <th scope="col">{translate('members.columns.role')}</th>
            <th scope="col">{translate('members.columns.state')}</th>
            <th scope="col">{translate('members.columns.rooms')}</th>
            <th scope="col">
              <span className="df-visually-hidden">{translate('members.columns.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {props.subjects.map((subject) =>
            subject.subjectKind === 'invitation' ? (
              <InvitationRow
                key={subject.subjectId}
                subject={subject}
                busy={props.busySubjectId === subject.subjectId}
                anyBusy={props.busySubjectId !== null}
                onRevoke={props.onRevokeInvitation}
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
                  props.onOpenRooms(subject.subjectId, trigger);
                }}
                onOpenTransfer={() => {
                  props.onOpenTransfer(subject.subjectId);
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
  );
}

function Cell({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  // `data-label` names stacked cells on narrow screens; column headers remain for AT.
  return <td data-label={label}>{children}</td>;
}

interface RowProps {
  readonly busy: boolean;
  readonly anyBusy: boolean;
}

function InvitationRow({
  subject,
  busy,
  anyBusy,
  onRevoke,
}: RowProps & {
  readonly subject: PendingInvitation;
  readonly onRevoke: (invitationId: string) => void;
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
        <span className="df-state">{translate(ROLE_LABEL[subject.intendedRole])}</span>
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
              onRevoke(subject.subjectId);
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
  /** The person's address travels with the change so the confirmation can name them. */
  readonly onRoleChange: (input: RoleChange, person: string) => void;
  readonly onStateChange: (input: StateChange, person: string) => void;
  readonly onOpenRooms: (trigger: HTMLButtonElement) => void;
  readonly onOpenTransfer: () => void;
}): React.ReactElement {
  const canAssign = isRoomAssignable(subject);
  const { setRole: canSetRole, setState: canSetState } = subject.capabilities;
  const canTransfer = isTransferTarget(subject);
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
      </Cell>
      <Cell label={translate('members.columns.state')}>
        <span className="df-state" data-live={subject.state === 'active' ? 'true' : 'false'}>
          {translate(STATE_LABEL[subject.state])}
        </span>
      </Cell>
      <Cell label={translate('members.columns.rooms')}>
        {byRole ? (
          <span className="df-register__meta">{translate('members.rooms.byRole')}</span>
        ) : subject.assignments.length === 0 ? (
          <span className="df-register__meta">{translate('members.rooms.none')}</span>
        ) : (
          <ul className="df-grants">
            {subject.assignments.map((assignment) => {
              const room = rooms.find((entry) => entry.roomId === assignment.roomId);
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
          {canAssign ? (
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
          {canSetRole ? (
            <button
              type="button"
              className="df-button df-button--quiet"
              data-busy={busy ? 'true' : 'false'}
              disabled={anyBusy}
              onClick={() => {
                onRoleChange(
                  {
                    memberId: subject.subjectId,
                    role: subject.globalRole === 'admin' ? 'member' : 'admin',
                    expectedRevision: subject.revision,
                  },
                  subject.emailDisplay,
                );
              }}
            >
              {translate(
                subject.globalRole === 'admin'
                  ? 'members.role.toMember'
                  : 'members.role.toAdmin',
              )}
              <span className="df-visually-hidden"> {subject.emailDisplay}</span>
            </button>
          ) : null}
          {canSetState ? (
            <button
              type="button"
              className={`df-button df-button--quiet${subject.state === 'active' ? ' df-button--danger' : ''}`}
              data-busy={busy ? 'true' : 'false'}
              disabled={anyBusy}
              onClick={() => {
                onStateChange(
                  {
                    memberId: subject.subjectId,
                    state: subject.state === 'disabled' ? 'active' : 'disabled',
                    expectedRevision: subject.revision,
                  },
                  subject.emailDisplay,
                );
              }}
            >
              {translate(
                subject.state === 'disabled' ? 'members.state.enable' : 'members.state.disable',
              )}
              <span className="df-visually-hidden"> {subject.emailDisplay}</span>
            </button>
          ) : null}
          {canTransfer ? (
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
        </div>
      </Cell>
    </tr>
  );
}
