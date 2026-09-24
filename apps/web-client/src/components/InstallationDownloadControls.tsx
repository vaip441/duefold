/**
 * The installation-wide original-download default: stated in words, with the one change
 * that differs from it. Both directions open on the server's review of what the change
 * reaches; allowing then takes the server's phrase and a fresh sign-in, denying one press.
 */
import { useRef, useState } from 'react';
import type {
  DownloadPolicy,
  InstallationDownloadChange,
  InstallationDownloadImpact,
  InstallationSettings,
} from '../api/client.ts';
import { translate, type MessageKey } from '../i18n/translate.ts';
import type { PresentedFailure } from '../workspace/failures.ts';
import type { InstallationSettingsSection } from '../workspace/useInstallationSettings.ts';
import {
  ConfirmationDialog,
  type Confirmation,
  type ConfirmationContent,
} from './ConfirmationDialog.tsx';

const COPY: Readonly<
  Record<
    DownloadPolicy,
    {
      readonly name: MessageKey;
      readonly change: MessageKey;
      readonly title: MessageKey;
      readonly consequence: MessageKey;
      readonly done: MessageKey;
    }
  >
> = {
  allow: {
    name: 'installation.download.allowed',
    change: 'installation.download.allow',
    title: 'installation.download.allow.title',
    consequence: 'installation.download.allow.consequence',
    done: 'installation.download.done.allow',
  },
  deny: {
    name: 'installation.download.denied',
    change: 'installation.download.deny',
    title: 'installation.download.deny.title',
    consequence: 'installation.download.deny.consequence',
    done: 'installation.download.done.deny',
  },
};

const OPPOSITE: Readonly<Record<DownloadPolicy, DownloadPolicy>> = {
  allow: 'deny',
  deny: 'allow',
};

/** The phrase is the server's and belongs to allowing; denying takes one press. */
export function confirmationFor(
  impact: InstallationDownloadImpact,
  finish: (change: InstallationDownloadChange) => Promise<PresentedFailure | null>,
): Confirmation {
  if (impact.proposedPolicy === 'allow')
    return {
      phrase: impact.confirmation,
      confirm: (typed) =>
        finish({
          policy: 'allow',
          expectedRevision: impact.expectedRevision,
          confirmation: typed,
        }),
    };
  return {
    phrase: null,
    confirm: () => finish({ policy: 'deny', expectedRevision: impact.expectedRevision }),
  };
}

export function Consequence({
  impact,
}: {
  readonly impact: InstallationDownloadImpact;
}): React.ReactElement {
  return (
    <>
      <p>
        {translate(COPY[impact.proposedPolicy].consequence, {
          rooms: impact.inheritingRoomCount,
          documents: impact.affectedDocumentCount,
        })}
      </p>
      {impact.requiresFreshAuthentication ? (
        <p className="df-field__help">{translate('installation.download.freshSignIn')}</p>
      ) : null}
    </>
  );
}

export interface InstallationDownloadControlsProps {
  readonly settings: InstallationSettings;
  readonly section: InstallationSettingsSection;
  readonly onStatus: (message: string) => void;
}

export function InstallationDownloadControls({
  settings,
  section,
  onStatus,
}: InstallationDownloadControlsProps): React.ReactElement {
  const [dialogue, setDialogue] = useState<{
    readonly review: number;
    readonly content: ConfirmationContent;
  } | null>(null);
  /* Every opening is its own review, so a slow answer cannot replace a newer one. */
  const reviews = useRef(0);
  const proposed = OPPOSITE[settings.downloadPolicy];

  const finish = async (
    change: InstallationDownloadChange,
  ): Promise<PresentedFailure | null> => {
    const failure = await section.applyDownload(change);
    if (failure === null) onStatus(translate(COPY[change.policy].done));
    return failure;
  };

  const begin = (): void => {
    reviews.current += 1;
    const review = reviews.current;
    setDialogue({ review, content: { kind: 'loading' } });
    void section.reviewDownload(proposed).then((outcome) => {
      setDialogue((current) =>
        current?.review !== review
          ? current
          : {
              review,
              content: outcome.ok
                ? {
                    kind: 'ready',
                    consequence: <Consequence impact={outcome.value} />,
                    confirmation: confirmationFor(outcome.value, finish),
                  }
                : { kind: 'failed', failure: outcome.failure },
            },
      );
    });
  };

  return (
    <div className="df-panel__block">
      <h3 className="df-panel__subheading">{translate('installation.download.heading')}</h3>
      <p>
        <strong>{translate(COPY[settings.downloadPolicy].name)}</strong> —{' '}
        {translate('installation.download.explain', { rooms: settings.inheritingRoomCount })}
      </p>
      <div className="df-panel__actions">
        <button type="button" className="df-button" onClick={begin}>
          {translate(COPY[proposed].change)}
        </button>
      </div>
      <ConfirmationDialog
        open={dialogue !== null}
        title={translate(COPY[proposed].title)}
        submitLabel={translate(COPY[proposed].change)}
        pendingLabel={translate('settings.pending')}
        content={dialogue?.content ?? { kind: 'loading' }}
        onClose={() => {
          setDialogue(null);
        }}
        onReload={section.reload}
      />
    </div>
  );
}
