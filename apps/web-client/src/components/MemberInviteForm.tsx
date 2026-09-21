import { useId, useState } from 'react';
import type { AssignableGlobalRole } from '../api/client.ts';
import { translate } from '../i18n/translate.ts';
import type { PresentedFailure } from '../workspace/failures.ts';
import { Notice } from './Notice.tsx';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export interface MemberInviteFormProps {
  readonly failure: PresentedFailure | null;
  readonly pending: boolean;
  readonly onInvite: (input: {
    readonly email: string;
    readonly intendedRole: AssignableGlobalRole;
  }) => void;
}

export function MemberInviteForm({
  failure,
  pending,
  onInvite,
}: MemberInviteFormProps): React.ReactElement {
  const id = useId();
  const [email, setEmail] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [role, setRole] = useState<AssignableGlobalRole>('member');
  const valid = EMAIL.test(email.trim());

  return (
    <div className="df-panel__block">
      <h3 className="df-panel__subheading">{translate('members.invite')}</h3>
      <p className="df-field__help">{translate('members.invite.note')}</p>
      {failure === null ? null : (
        <Notice
          tone="problem"
          role="alert"
          {...(failure.title === null ? {} : { title: failure.title })}
        >
          {failure.body}
        </Notice>
      )}
      <div className="df-field">
        <label className="df-field__label" htmlFor={`${id}-email`}>
          {translate('members.invite.email')}
        </label>
        <input
          id={`${id}-email`}
          className="df-field__input"
          type="email"
          autoComplete="email"
          value={email}
          disabled={pending}
          aria-invalid={attempted && !valid ? 'true' : undefined}
          aria-describedby={attempted && !valid ? `${id}-error` : `${id}-help`}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
        />
        <p className="df-field__help" id={`${id}-help`}>
          {translate('members.invite.emailHelp')}
        </p>
        {attempted && !valid ? (
          <p className="df-field__error" id={`${id}-error`} role="alert">
            {translate('members.invite.invalid')}
          </p>
        ) : null}
      </div>
      <div className="df-field">
        <label className="df-field__label" htmlFor={`${id}-role`}>
          {translate('members.invite.role')}
        </label>
        <select
          id={`${id}-role`}
          className="df-field__input"
          value={role}
          disabled={pending}
          aria-describedby={`${id}-role-help`}
          onChange={(event) => {
            setRole(event.target.value === 'admin' ? 'admin' : 'member');
          }}
        >
          <option value="member">{translate('members.role.member')}</option>
          <option value="admin">{translate('members.role.admin')}</option>
        </select>
        <p className="df-field__help" id={`${id}-role-help`}>
          {translate(
            role === 'admin' ? 'members.role.admin.explain' : 'members.role.member.explain',
          )}
        </p>
      </div>
      <div className="df-panel__actions">
        <button
          type="button"
          className="df-button df-button--primary"
          data-busy={pending ? 'true' : 'false'}
          disabled={pending}
          onClick={() => {
            setAttempted(true);
            if (!valid) return;
            onInvite({ email: email.trim(), intendedRole: role });
            setEmail('');
            setAttempted(false);
          }}
        >
          {pending ? translate('members.invite.pending') : translate('members.invite.submit')}
        </button>
      </div>
    </div>
  );
}
