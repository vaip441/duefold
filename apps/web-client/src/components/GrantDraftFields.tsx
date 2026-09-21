/**
 * The target and expiry fields of a grant change.
 *
 * Shared by the individual and counterparty grant forms, because the fields of a grant do not
 * depend on who it is for: two copies would let the two surfaces drift into offering different
 * targets or validating an expiry differently.
 */
import { useId, type ReactElement } from 'react';
import type { GrantTargetKind, WorkingEntry } from '../api/client.ts';
import { translate } from '../i18n/translate.ts';
import type { GrantDraft, GrantDraftProblem } from '../workspace/grants.ts';

export interface GrantDraftFieldsProps {
  readonly draft: GrantDraft;
  readonly problems: readonly GrantDraftProblem[];
  readonly folders: readonly WorkingEntry[];
  readonly documents: readonly WorkingEntry[];
  readonly firstField?: React.Ref<HTMLSelectElement | HTMLInputElement>;
  readonly onDraftChange: (draft: GrantDraft) => void;
}

export function GrantDraftFields({
  draft,
  problems,
  folders,
  documents,
  firstField,
  onDraftChange,
}: GrantDraftFieldsProps): ReactElement {
  const fieldId = useId();
  const action = draft.changeAction;

  return (
    <>
      {action === 'grant' ? (
        <>
          <div className="df-field">
            <label className="df-field__label" htmlFor={`${fieldId}-target`}>
              {translate('grant.target.label')}
            </label>
            <select
              id={`${fieldId}-target`}
              className="df-field__input"
              ref={firstField as React.Ref<HTMLSelectElement>}
              value={draft.targetKind ?? ''}
              aria-invalid={problems.includes('target-required') ? 'true' : undefined}
              onChange={(event) => {
                const value = event.target.value;
                onDraftChange({
                  ...draft,
                  targetKind: value === '' ? null : (value as GrantTargetKind),
                  folderId: null,
                  documentId: null,
                });
              }}
            >
              <option value="">{translate('grant.target.pick')}</option>
              <option value="room">{translate('grant.target.room')}</option>
              <option value="folder">{translate('grant.target.folder')}</option>
              <option value="document">{translate('grant.target.document')}</option>
            </select>
          </div>

          {draft.targetKind === 'folder' ? (
            <div className="df-field">
              <label className="df-field__label" htmlFor={`${fieldId}-folder`}>
                {translate('grant.target.folder')}
              </label>
              <select
                id={`${fieldId}-folder`}
                className="df-field__input"
                value={draft.folderId ?? ''}
                onChange={(event) => {
                  onDraftChange({
                    ...draft,
                    folderId: event.target.value === '' ? null : event.target.value,
                  });
                }}
              >
                <option value="">{translate('grant.target.pick')}</option>
                {folders.map((folder) => (
                  <option key={folder.resourceId} value={folder.resourceId}>
                    {folder.displayName}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {draft.targetKind === 'document' ? (
            <div className="df-field">
              <label className="df-field__label" htmlFor={`${fieldId}-document`}>
                {translate('grant.target.document')}
              </label>
              <select
                id={`${fieldId}-document`}
                className="df-field__input"
                value={draft.documentId ?? ''}
                onChange={(event) => {
                  onDraftChange({
                    ...draft,
                    documentId: event.target.value === '' ? null : event.target.value,
                  });
                }}
              >
                <option value="">{translate('grant.target.pick')}</option>
                {documents.map((document) => (
                  <option key={document.resourceId} value={document.resourceId}>
                    {document.displayName}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </>
      ) : null}

      {action === 'revoke' ? null : (
        <div className="df-field">
          <label className="df-field__label" htmlFor={`${fieldId}-expiry`}>
            {translate('grant.expiry.label')}
          </label>
          <input
            id={`${fieldId}-expiry`}
            className="df-field__input"
            type="date"
            value={draft.expiresOn}
            ref={action === 'expiry' ? (firstField as React.Ref<HTMLInputElement>) : null}
            aria-invalid={
              problems.includes('expiry-past') || problems.includes('expiry-required')
                ? 'true'
                : undefined
            }
            aria-describedby={`${fieldId}-expiry-help`}
            onChange={(event) => {
              onDraftChange({ ...draft, expiresOn: event.target.value });
            }}
          />
          <p className="df-field__help" id={`${fieldId}-expiry-help`}>
            {translate('grant.expiry.help')}
          </p>
          {problems.includes('expiry-past') ? (
            <p className="df-field__error" role="alert">
              {translate('grant.expiry.past')}
            </p>
          ) : null}
        </div>
      )}

      {problems.includes('target-required') ? (
        <p className="df-field__error" role="alert">
          {translate('grant.target.pick')}
        </p>
      ) : null}
    </>
  );
}
