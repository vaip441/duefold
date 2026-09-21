/**
 * The ownership-transfer preview and typed confirmation.
 *
 * This is the highest-consequence change in the product, and this component's job is
 * to make sure the Owner approves what will actually happen rather than what they
 * assumed:
 *
 * 1. THE IMPACT IS THE SERVER'S. The successor's name, the rooms the promotion will
 *    revoke, the exact count, and the confirmation phrase all come from the dry run.
 *    Nothing here estimates any of them; a second local definition could disagree
 *    with the authoritative one and the Owner would be approving a wrong number.
 * 2. PROMOTION REVOKES ASSIGNMENTS, SO THIS NAMES THEM. An Owner reaches every room,
 *    so the successor's explicit assignments are superseded. A preview that described
 *    only the role change would ask for consent to a privilege revocation it never
 *    mentioned, and a typed phrase cannot consent to something unseen.
 * 3. A CAPPED LIST SAYS SO. The named rooms are capped because they carry titles; the
 *    count stays exact, and the truncation notice appears rather than letting a short
 *    list read as the whole impact.
 *
 * It is a plain component rather than part of the dialog because the dialog's portal
 * is a browser mechanism, and these statements are the part worth pinning with a test
 * that does not need one. The dialog supplies focus management and dismissal.
 */

import { useId } from 'react';
import type { OwnershipTransferImpact } from '../api/client.ts';
import { translate } from '../i18n/translate.ts';
import { confirmationMatches } from '../workspace/administration.ts';
import type { PresentedFailure } from '../workspace/failures.ts';
import { Notice } from './Notice.tsx';

export interface OwnershipTransferPreviewProps {
  /** Null until the dry run returns. No confirmation field exists before then. */
  readonly impact: OwnershipTransferImpact | null;
  readonly loading: boolean;
  readonly pending: boolean;
  readonly failure: PresentedFailure | null;
  readonly typed: string;
  /** Id of the paragraph describing the irreversible effect, for the dialog. */
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
  /* The mismatch is explained while typing rather than on a rejected submit, because
     the submit is DISABLED until the phrase matches: an error that only appeared after
     a click could never appear at all.
     `typed !== ''` and not `typed.trim() !== ''`: a lone space is already a mismatch the
     comparison refuses, so saying so is more honest than treating it as "nothing typed"
     while the submit stays disabled for a reason the surface never states. */
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
          {/* A 409 here means the target changed after the preview was issued, so the
              preview no longer describes what would happen. Saying "this room changed"
              would name the wrong thing. */}
          {failure.kind === 'conflict' ? translate('members.transfer.stale') : failure.body}
        </Notice>
      )}

      {impact === null || loading ? null : (
        <>
          <p className="df-modal__lead">
            {translate('members.transfer.target', { person: impact.targetEmailDisplay })}
          </p>
          {/* The dialog is described by this, so it is announced with the dialog
              rather than found by reading down the panel. */}
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
                {/* A capped list says so, so a short list cannot read as the whole
                    impact. The count above stays exact either way. */}
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
                        {/*
                         * Labelled per cell for the same reason the member register is.
                         * The stylesheet block-stacks every `.df-register` at narrow
                         * widths and hides the header row, so without `data-label` these
                         * two values became a room title with a bare role beneath it —
                         * inside the one dialog where the Owner is approving an
                         * irreversible privilege revocation. The real `<th scope="col">`
                         * headers stay in the DOM, visually hidden, so the programmatic
                         * association is intact and the label is presentation only.
                         */}
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
