/**
 * One document's download exception, on its collection row.
 *
 * Choosing a value opens the confirmation dialog on its consequence; the select keeps
 * showing the current value until the change commits, so a cancelled choice leaves
 * nothing half-applied on screen.
 */
import { useState } from 'react';
import type { DocumentEntry, DownloadPolicy } from '../api/client.ts';
import { translate, type MessageKey } from '../i18n/translate.ts';
import type { PresentedFailure } from '../workspace/failures.ts';
import { ConfirmationDialog } from './ConfirmationDialog.tsx';

const CHOICE: Readonly<Record<string, DownloadPolicy | null>> = {
  inherit: null,
  allow: 'allow',
  deny: 'deny',
};
const WORD: Readonly<Record<DownloadPolicy, MessageKey>> = {
  allow: 'settings.download.word.allow',
  deny: 'settings.download.word.deny',
};
const MARKER: Readonly<Record<DownloadPolicy, MessageKey>> = {
  allow: 'downloads.marker.allow',
  deny: 'downloads.marker.deny',
};

function consequence(policy: DownloadPolicy | null): MessageKey {
  if (policy === null) return 'downloads.consequence.inherit';
  return policy === 'allow' ? 'downloads.consequence.allow' : 'downloads.consequence.deny';
}

export function DownloadMarker({
  policy,
}: {
  readonly policy: DownloadPolicy | null;
}): React.ReactElement | null {
  return policy === null ? null : (
    <span className="df-field__help">{translate(MARKER[policy])}</span>
  );
}

export interface DownloadOverrideControlProps {
  readonly entry: DocumentEntry;
  /** The document's own policy, or null when it inherits. */
  readonly current: DownloadPolicy | null;
  readonly inherited: DownloadPolicy;
  readonly onChange: (policy: DownloadPolicy | null) => Promise<PresentedFailure | null>;
  readonly onReload: () => void;
}

export function DownloadOverrideControl({
  entry,
  current,
  inherited,
  onChange,
  onReload,
}: DownloadOverrideControlProps): React.ReactElement {
  const [proposed, setProposed] = useState<{ readonly policy: DownloadPolicy | null } | null>(
    null,
  );
  const inheritedWord = translate(WORD[inherited]);

  return (
    <>
      <select
        className="df-field__input"
        aria-label={translate('downloads.label', { name: entry.displayName })}
        value={current ?? 'inherit'}
        onChange={(event) => {
          const policy = CHOICE[event.target.value];
          if (policy !== undefined && policy !== current) setProposed({ policy });
        }}
      >
        <option value="inherit">
          {translate('downloads.inherit', { policy: inheritedWord })}
        </option>
        <option value="allow">{translate('downloads.allow')}</option>
        <option value="deny">{translate('downloads.deny')}</option>
      </select>
      <ConfirmationDialog
        open={proposed !== null}
        title={translate('downloads.title', { name: entry.displayName })}
        submitLabel={translate('downloads.apply')}
        pendingLabel={translate('settings.pending')}
        content={
          proposed === null
            ? { kind: 'loading' }
            : {
                kind: 'ready',
                consequence: (
                  <p>{translate(consequence(proposed.policy), { policy: inheritedWord })}</p>
                ),
                confirmation: { phrase: null, confirm: () => onChange(proposed.policy) },
              }
        }
        onClose={() => {
          setProposed(null);
        }}
        onReload={onReload}
      />
    </>
  );
}
