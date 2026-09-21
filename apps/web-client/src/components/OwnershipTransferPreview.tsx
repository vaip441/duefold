import { useId } from 'react';
import type { OwnershipTransferImpact } from '../api/client.ts';
import { translate } from '../i18n/translate.ts';
import { confirmationMatches } from '../workspace/administration.ts';
import type { PresentedFailure } from '../workspace/failures.ts';
import { Notice } from './Notice.tsx';

export interface OwnershipTransferPreviewProps {
  readonly impact: OwnershipTransferImpact | null;
  readonly loading: boolean;
  readonly pending: boolean;
  readonly failure: PresentedFailure | null;
  readonly typed: string;
  readonly describedById: string;
  readonly onTypedChange: (value: string) => void;
}

export function OwnershipTransferPreview({
  impact,
  loading,
  pending,
  failure,
  typed,
  describedById,
  onTypedChange,
}: OwnershipTransferPreviewProps): React.ReactElement {
  const confirmId = useId();
  const matches = confirmationMatches(typed, impact?.confirmation ?? null);
  const mismatch = typed !== '' && !matches;

  return (
    <>
      {loading ? (
        <p className="df-field__help">{translate('members.transfer.loading')}</p>
      ) : null}

      {failure === null ? null : (
        <Notice
          tone="problem"
          role="alert"
          {...(failure.title === null ? {} : { title: failure.title })}
        >
          {failure.kind === 'conflict' ? translate('members.transfer.stale') : failure.body}
        </Notice>
      )}

      {impact === null || loading ? null : (
        <>
          <p className="df-modal__lead">
            {translate('members.transfer.target', { person: impact.targetEmailDisplay })}
          </p>
          <p className="df-field__help" id={describedById}>
            {translate('members.transfer.consequence')}
          </p>

          <div className="df-impact">
            <h3 className="df-panel__subheading">
              {impact.revokedAssignmentCount === 0
                ? translate('members.transfer.revokesNone')
                : translate('members.transfer.revokes', {
                    count: impact.revokedAssignmentCount,
                  })}
            </h3>
            {impact.revokedAssignmentCount === 0 ? null : (
              <>
                <p className="df-field__help">{translate('members.transfer.revokesWhy')}</p>
                {impact.revokedAssignmentsTruncated ? (
                  <Notice tone="caution">
                    {translate('members.transfer.revokesTruncated')}
                  </Notice>
                ) : null}
                <table className="df-register df-register--compact">
                  <caption className="df-visually-hidden">
                    {translate('members.transfer.revokes', {
                      count: impact.revokedAssignmentCount,
                    })}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">{translate('members.transfer.columns.room')}</th>
                      <th scope="col">{translate('members.transfer.columns.role')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {impact.revokedAssignments.map((assignment) => (
                      <tr key={assignment.roomId}>
                        <th
                          scope="row"
                          className="df-register__name"
                          data-label={translate('members.transfer.columns.room')}
                        >
                          {assignment.roomTitle}
                        </th>
                        <td data-label={translate('members.transfer.columns.role')}>
                          {translate(
                            assignment.roomRole === 'manager'
                              ? 'members.assign.manager'
                              : 'members.assign.contributor',
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>

          <div className="df-field">
            <label className="df-field__label" htmlFor={confirmId}>
              {translate('members.transfer.confirmLabel', { phrase: impact.confirmation })}
            </label>
            <input
              id={confirmId}
              className="df-field__input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={typed}
              disabled={pending}
              aria-invalid={mismatch ? 'true' : undefined}
              aria-describedby={mismatch ? `${confirmId}-error` : undefined}
              onChange={(event) => {
                onTypedChange(event.target.value);
              }}
            />
            {mismatch ? (
              <p className="df-field__error" id={`${confirmId}-error`} role="alert">
                {translate('members.transfer.mismatch')}
              </p>
            ) : null}
          </div>
        </>
      )}
    </>
  );
}
