/**
 * Who can read this room, and how to change it.
 *
 * This is the surface where a mistake is most expensive, so three things are
 * non-negotiable in its construction:
 *
 * 1. EXPIRED GRANTS ARE SHOWN. The server returns `effective: false` rather than
 *    omitting them, because a Manager cannot repair access they cannot see. An
 *    expired grant is labelled as expired and never rendered as ordinary access.
 * 2. IMPACT COMES FROM THE SERVER. The affected count, the paths, and the
 *    confirmation phrase are the dry-run's. Nothing here estimates who will gain
 *    or lose access; a second local definition of access could disagree with the
 *    authoritative one and a Manager would be deciding on a wrong number.
 * 3. THE PHRASE IS THE SERVER'S. Apply echoes the dry-run's `grantId`,
 *    `confirmation`, and the room revision it saw, so a caller that skipped the
 *    preview cannot guess them and a stale room is refused rather than silently
 *    overwritten.
 *
 * A revoked membership is stated in words. Hiding a revoked reader would leave a
 * Manager believing access ended when the row is still there to be understood.
 */

import { useEffect, useId, useRef, useState } from 'react';
import type {
  GrantChangeAction,
  GrantImpact,
  Participant,
  WorkingEntry,
} from '../api/client.ts';
import { translate } from '../i18n/translate.ts';
import {
  describeGrant,
  formatDate,
  grantableTargets,
  validateGrantDraft,
  type GrantDraft,
  type GrantDraftProblem,
  type GrantSubmission,
} from '../workspace/grants.ts';
import type { PresentedFailure } from '../workspace/failures.ts';
import { GrantDraftFields } from './GrantDraftFields.tsx';
import { Notice } from './Notice.tsx';

export interface ParticipantsPanelProps {
  readonly participants: readonly Participant[];
  readonly entries: readonly WorkingEntry[];
  readonly loading: boolean;
  /* True when the load FAILED. The empty state must not stand in for a refusal:
     telling an operator "nothing is here" when the data was denied represents
     inaccessible content as absent. */
  readonly denied: boolean;
  readonly failure: PresentedFailure | null;
  readonly inviteFailure: PresentedFailure | null;
  readonly invitePending: boolean;
  /** Server-computed impact for the change under review, or null before review. */
  readonly impact: GrantImpact | null;
  readonly impactLoading: boolean;
  readonly applyPending: boolean;
  readonly changeFailure: PresentedFailure | null;
  readonly onInvite: (email: string) => void;
  readonly onReview: (submission: GrantSubmission) => void;
  readonly onApply: (confirmation: string) => void;
  readonly onCancelChange: () => void;
  readonly onReload: () => void;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function ParticipantsPanel({
  participants,
  entries,
  loading,
  denied,
  failure,
  inviteFailure,
  invitePending,
  impact,
  impactLoading,
  applyPending,
  changeFailure,
  onInvite,
  onReview,
  onApply,
  onCancelChange,
  onReload,
}: ParticipantsPanelProps): React.ReactElement {
  const headingId = useId();
  const inviteId = useId();
  const [email, setEmail] = useState('');
  const [emailAttempted, setEmailAttempted] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<GrantDraft>({
    changeAction: 'grant',
    targetKind: null,
    folderId: null,
    documentId: null,
    expiresOn: '',
  });
  const [draftAttempted, setDraftAttempted] = useState(false);
  const [typed, setTyped] = useState('');
  const [typedAttempted, setTypedAttempted] = useState(false);

  const folders = grantableTargets(entries, 'folder');
  const documents = grantableTargets(entries, 'document');
  const problems = validateGrantDraft(draft, new Date());
  const emailValid = EMAIL.test(email.trim());

  if (loading)
    return (
      <section aria-labelledby={headingId}>
        <h2 className="df-section__heading" id={headingId}>
          {translate('participants.heading')}
        </h2>
        <p className="df-field__help">{translate('participants.loading')}</p>
      </section>
    );

  if (failure !== null)
    return (
      <section aria-labelledby={headingId}>
        <h2 className="df-section__heading" id={headingId}>
          {translate('participants.heading')}
        </h2>
        <Notice
          tone="problem"
          role="alert"
          {...(failure.title === null ? {} : { title: failure.title })}
        >
          {failure.body}
        </Notice>
        {failure.offerReload ? (
          <button type="button" className="df-button" onClick={onReload}>
            {translate('error.conflict.reload')}
          </button>
        ) : null}
      </section>
    );

  return (
    <section aria-labelledby={headingId}>
      <h2 className="df-section__heading" id={headingId}>
        {translate('participants.heading')}
      </h2>

      {denied ? null : participants.length === 0 ? (
        <div className="df-empty">
          <span className="df-empty__lead">{translate('participants.empty')}</span>
          {translate('participants.emptyHelp')}
        </div>
      ) : (
        <table className="df-register">
          <caption className="df-visually-hidden">{translate('participants.heading')}</caption>
          <thead>
            <tr>
              <th scope="col">{translate('participants.columns.reader')}</th>
              <th scope="col">{translate('participants.columns.membership')}</th>
              <th scope="col">{translate('participants.columns.grants')}</th>
              <th scope="col">{translate('participants.columns.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {participants.map((participant) => (
              <tr key={participant.viewerId} data-membership={participant.membershipState}>
                <th scope="row" className="df-register__name">
                  {participant.email}
                  {participant.counterpartyName === null ? null : (
                    <span className="df-register__meta">
                      {translate('participants.counterparty', {
                        name: participant.counterpartyName,
                      })}
                    </span>
                  )}
                </th>
                <td>
                  <span
                    className="df-state"
                    data-live={participant.membershipState === 'active' ? 'true' : 'false'}
                  >
                    {translate(`participants.membership.${participant.membershipState}`)}
                  </span>
                  {participant.membershipState === 'revoked' ? (
                    <span className="df-register__meta">
                      {translate('participants.membership.revokedHelp')}
                    </span>
                  ) : null}
                </td>
                <td>
                  {participant.grants.length === 0 ? (
                    <>
                      <span className="df-state">{translate('participants.noGrants')}</span>
                      <span className="df-register__meta">
                        {translate('participants.noGrantsHelp')}
                      </span>
                    </>
                  ) : (
                    <ul className="df-grants">
                      {participant.grants.map((grant) => {
                        const described = describeGrant(grant, participant.counterpartyName);
                        return (
                          <li
                            key={grant.grantId}
                            data-expired={described.expired ? 'true' : 'false'}
                          >
                            <span className="df-grants__target">{described.target}</span>
                            <span className="df-register__meta">{described.origin}</span>
                            {/* Expiry in words. An expired grant says so. */}
                            <span className="df-register__meta" data-numeric="true">
                              {described.expiry}
                            </span>
                            {described.expired ? (
                              <span className="df-grants__expired">
                                {translate('participants.grant.expiredHelp')}
                              </span>
                            ) : null}
                            {/* Expiry and revoke act on THIS grant. A single
                                per-participant action submitted grants[0], so a
                                participant holding several grants could not choose
                                which to change and the wrong access was altered. */}
                            {grant.source === 'direct' ? (
                              <span className="df-grants__actions">
                                {(['expiry', 'revoke'] as readonly GrantChangeAction[]).map(
                                  (action) => (
                                    <button
                                      key={action}
                                      type="button"
                                      className="df-button df-button--quiet"
                                      onClick={() => {
                                        setEditing(
                                          `${participant.viewerId}:${action}:${grant.grantId}`,
                                        );
                                        setDraft({
                                          changeAction: action,
                                          targetKind: grant.targetKind,
                                          folderId: grant.folderId,
                                          documentId: grant.documentId,
                                          expiresOn: '',
                                        });
                                        setDraftAttempted(false);
                                        setTyped('');
                                        setTypedAttempted(false);
                                        onCancelChange();
                                      }}
                                    >
                                      {translate(`grant.action.${action}`)}
                                      <span className="df-visually-hidden">
                                        {' '}
                                        {described.target} — {participant.email}
                                      </span>
                                    </button>
                                  ),
                                )}
                              </span>
                            ) : (
                              <span className="df-register__meta">
                                {translate('participants.grant.inheritedHelp')}
                              </span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </td>
                <td>
                  <div className="df-register__actions">
                    {/* Only granting is participant-level; expiry and revoke live on
                      the specific grant they change. */}
                    <button
                      type="button"
                      className="df-button df-button--quiet"
                      onClick={() => {
                        setEditing(`${participant.viewerId}:grant:`);
                        setDraft({
                          changeAction: 'grant',
                          targetKind: null,
                          folderId: null,
                          documentId: null,
                          expiresOn: '',
                        });
                        setDraftAttempted(false);
                        setTyped('');
                        setTypedAttempted(false);
                        onCancelChange();
                      }}
                    >
                      {translate('grant.action.grant')}
                      <span className="df-visually-hidden"> {participant.email}</span>
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing === null
        ? null
        : (() => {
            const [viewerId = '', action = 'grant', grantId = ''] = editing.split(':');
            const participant = participants.find((entry) => entry.viewerId === viewerId);
            if (participant === undefined) return null;
            /*
             * The exact grant the operator chose, never grants[0]. An unmatched id
             * for a change that requires one refuses rather than silently falling
             * back to a different grant.
             */
            const existing =
              grantId === ''
                ? undefined
                : participant.grants.find((grant) => grant.grantId === grantId);
            if (action !== 'grant' && existing === undefined) return null;
            return (
              <GrantChangeForm
                participant={participant}
                action={action as GrantChangeAction}
                draft={draft}
                problems={draftAttempted ? problems : []}
                folders={folders}
                documents={documents}
                impact={impact}
                impactLoading={impactLoading}
                applyPending={applyPending}
                failure={changeFailure}
                typed={typed}
                typedAttempted={typedAttempted}
                onDraftChange={setDraft}
                onReview={() => {
                  setDraftAttempted(true);
                  if (problems.length > 0) return;
                  onReview({
                    grantee: {
                      kind: 'viewer',
                      viewerId: participant.viewerId,
                      label: participant.email,
                    },
                    draft,
                    ...(existing === undefined ? {} : { grantId: existing.grantId }),
                  });
                }}
                onTypedChange={setTyped}
                onApply={() => {
                  setTypedAttempted(true);
                  if (impact !== null && typed.trim() === impact.confirmation)
                    onApply(typed.trim());
                }}
                onCancel={() => {
                  setEditing(null);
                  onCancelChange();
                }}
                onReload={onReload}
              />
            );
          })()}

      <div className="df-panel__block">
        <h3 className="df-panel__subheading">{translate('participants.invite')}</h3>
        <p className="df-field__help">{translate('participants.invite.note')}</p>
        {inviteFailure === null ? null : (
          <Notice
            tone="problem"
            role="alert"
            {...(inviteFailure.title === null ? {} : { title: inviteFailure.title })}
          >
            {inviteFailure.body}{' '}
            {inviteFailure.offerReload ? (
              <button type="button" className="df-textlink" onClick={onReload}>
                {translate('error.conflict.reload')}
              </button>
            ) : null}
          </Notice>
        )}
        <div className="df-field">
          <label className="df-field__label" htmlFor={inviteId}>
            {translate('participants.invite.email')}
          </label>
          <input
            id={inviteId}
            className="df-field__input"
            type="email"
            autoComplete="email"
            value={email}
            disabled={invitePending}
            aria-invalid={emailAttempted && !emailValid ? 'true' : undefined}
            aria-describedby={
              emailAttempted && !emailValid ? `${inviteId}-error` : `${inviteId}-help`
            }
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
          <p className="df-field__help" id={`${inviteId}-help`}>
            {translate('participants.invite.emailHelp')}
          </p>
          {emailAttempted && !emailValid ? (
            <p className="df-field__error" id={`${inviteId}-error`} role="alert">
              {translate('participants.invite.invalid')}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          className="df-button df-button--primary"
          data-busy={invitePending ? 'true' : 'false'}
          disabled={invitePending}
          onClick={() => {
            setEmailAttempted(true);
            if (!EMAIL.test(email.trim())) return;
            onInvite(email.trim());
            setEmail('');
            setEmailAttempted(false);
          }}
        >
          {invitePending
            ? translate('participants.invite.pending')
            : translate('participants.invite.submit')}
        </button>
      </div>
    </section>
  );
}

interface GrantChangeFormProps {
  readonly participant: Participant;
  readonly action: GrantChangeAction;
  readonly draft: GrantDraft;
  readonly problems: readonly GrantDraftProblem[];
  readonly folders: readonly WorkingEntry[];
  readonly documents: readonly WorkingEntry[];
  readonly impact: GrantImpact | null;
  readonly impactLoading: boolean;
  readonly applyPending: boolean;
  readonly failure: PresentedFailure | null;
  readonly typed: string;
  readonly typedAttempted: boolean;
  readonly onDraftChange: (draft: GrantDraft) => void;
  readonly onReview: () => void;
  readonly onTypedChange: (value: string) => void;
  readonly onApply: () => void;
  readonly onCancel: () => void;
  readonly onReload: () => void;
}

/**
 * The change form and its server-computed impact.
 *
 * The confirmation field only appears once the server has returned an impact, so
 * a member cannot type a phrase before seeing what it confirms.
 */
function GrantChangeForm({
  participant,
  action,
  draft,
  problems,
  folders,
  documents,
  impact,
  impactLoading,
  applyPending,
  failure,
  typed,
  typedAttempted,
  onDraftChange,
  onReview,
  onTypedChange,
  onApply,
  onCancel,
  onReload,
}: GrantChangeFormProps): React.ReactElement {
  const fieldId = useId();
  const firstField = useRef<HTMLSelectElement | HTMLInputElement | null>(null);
  useEffect(() => {
    firstField.current?.focus();
  }, []);
  const matches = impact !== null && typed.trim() === impact.confirmation;

  return (
    <div className="df-panel__block" data-grant-form="true">
      <h3 className="df-panel__subheading">
        {translate(`grant.action.${action}`)} — {participant.email}
      </h3>

      {action === 'revoke' ? (
        <Notice tone="caution">{translate('grant.revoke.warning')}</Notice>
      ) : null}

      <GrantDraftFields
        draft={draft}
        problems={problems}
        folders={folders}
        documents={documents}
        firstField={firstField}
        onDraftChange={onDraftChange}
      />

      {failure === null ? null : (
        <Notice
          tone="problem"
          role="alert"
          {...(failure.title === null ? {} : { title: failure.title })}
        >
          {failure.body}{' '}
          {failure.offerReload ? (
            <button type="button" className="df-textlink" onClick={onReload}>
              {translate('error.conflict.reload')}
            </button>
          ) : null}
        </Notice>
      )}

      {impactLoading ? (
        <p className="df-field__help">{translate('grant.impact.loading')}</p>
      ) : null}

      {impact === null || impactLoading ? null : (
        <div className="df-impact">
          <h4 className="df-panel__subheading">{translate('grant.impact.title')}</h4>
          <p className="df-field__help">{translate('grant.impact.explain')}</p>
          {/* Server's count and paths, never a local estimate. */}
          <p className="df-field__help" data-numeric="true">
            {impact.affectedCount === 0
              ? translate('grant.impact.none')
              : translate('grant.impact.count', { count: impact.affectedCount })}
          </p>
          <p className="df-field__help">
            {impact.resolvedExpiresAt === null
              ? translate('grant.impact.noExpiry')
              : translate('grant.impact.expiry', {
                  date: formatDate(impact.resolvedExpiresAt),
                })}
          </p>
          {impact.paths.length === 0 ? null : (
            <>
              <h5 className="df-visually-hidden">{translate('grant.impact.paths')}</h5>
              <ul className="df-results">
                {impact.paths.map((path) => (
                  <li key={path}>
                    <span className="df-register__meta">{path}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="df-field">
            <label className="df-field__label" htmlFor={`${fieldId}-confirm`}>
              {translate('grant.confirm.label', { phrase: impact.confirmation })}
            </label>
            <input
              id={`${fieldId}-confirm`}
              className="df-field__input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={typed}
              disabled={applyPending}
              aria-invalid={typedAttempted && !matches ? 'true' : undefined}
              aria-describedby={
                typedAttempted && !matches ? `${fieldId}-confirm-error` : undefined
              }
              onChange={(event) => {
                onTypedChange(event.target.value);
              }}
            />
            {typedAttempted && !matches ? (
              <p className="df-field__error" id={`${fieldId}-confirm-error`} role="alert">
                {translate('grant.confirm.mismatch')}
              </p>
            ) : null}
          </div>
        </div>
      )}

      <div className="df-panel__actions">
        {impact === null ? (
          <button
            type="button"
            className="df-button df-button--primary"
            data-busy={impactLoading ? 'true' : 'false'}
            disabled={impactLoading}
            onClick={onReview}
          >
            {impactLoading ? translate('grant.review.pending') : translate('grant.review')}
          </button>
        ) : (
          <button
            type="button"
            className="df-button df-button--primary"
            data-busy={applyPending ? 'true' : 'false'}
            disabled={applyPending}
            onClick={onApply}
          >
            {applyPending
              ? translate('grant.confirm.pending')
              : translate('grant.confirm.submit')}
          </button>
        )}
        <button type="button" className="df-button" disabled={applyPending} onClick={onCancel}>
          {translate('structure.cancel')}
        </button>
      </div>
    </div>
  );
}
