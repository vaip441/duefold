/**
 * Room download policy and default grant expiry.
 *
 * Inheriting is a real choice with a stated value, not an absence. Both changes open the
 * confirmation dialog on their consequence; default expiry shows the exact instant new
 * grants will inherit (§9.2) and requires the server's phrase.
 */
import { useId, useRef, useState } from 'react';
import type { DownloadPolicy, RoomSettings } from '../api/client.ts';
import { translate, type MessageKey } from '../i18n/translate.ts';
import { expiryDisplay, parseExpiryField } from '../workspace/room-settings.ts';
import type { RoomSettingsSection } from '../workspace/useRoomSettings.ts';
import { ConfirmationDialog, type ConfirmationContent } from './ConfirmationDialog.tsx';

type Choice = DownloadPolicy | 'inherit';

interface Dialogue {
  readonly review: number;
  readonly title: MessageKey;
  readonly submit: MessageKey;
  readonly content: ConfirmationContent;
}

const CONSEQUENCE: Readonly<Record<Choice, MessageKey>> = {
  allow: 'settings.download.consequence.allow',
  deny: 'settings.download.consequence.deny',
  inherit: 'settings.download.consequence.inherit',
};
const POLICY_WORD: Readonly<Record<DownloadPolicy, MessageKey>> = {
  allow: 'settings.download.word.allow',
  deny: 'settings.download.word.deny',
};

export interface RoomPolicyControlsProps {
  readonly settings: RoomSettings;
  readonly overrideCount: number;
  readonly section: RoomSettingsSection;
  readonly onStatus: (message: string) => void;
}

export function RoomPolicyControls({
  settings,
  overrideCount,
  section,
  onStatus,
}: RoomPolicyControlsProps): React.ReactElement {
  const legendId = useId();
  const expiryField = useId();
  const current: Choice = settings.downloadPolicy ?? 'inherit';
  const [choice, setChoice] = useState<Choice>(current);
  const [expiresOn, setExpiresOn] = useState('');
  const [dialogue, setDialogue] = useState<Dialogue | null>(null);
  const reviews = useRef(0);
  const installation = translate(POLICY_WORD[settings.installationDownloadPolicy]);

  const saveDownloads = (): void => {
    reviews.current += 1;
    const review = reviews.current;
    setDialogue({
      review,
      title: 'settings.download.title',
      submit: 'settings.download.save',
      content: {
        kind: 'ready',
        consequence: <p>{translate(CONSEQUENCE[choice], { policy: installation })}</p>,
        confirmation: {
          phrase: null,
          confirm: async () => {
            const failure = await section.setRoomDownloadPolicy(
              choice === 'inherit' ? null : choice,
              settings.revision,
            );
            if (failure === null) onStatus(translate('settings.download.done'));
            return failure;
          },
        },
      },
    });
  };

  const expiry = parseExpiryField(expiresOn);
  /* Only once something has been typed: an error beside an untouched field is noise. */
  const rejected = expiresOn !== '' && !expiry.ok;

  const reviewExpiry = (expiresAt: string | null): void => {
    reviews.current += 1;
    const review = reviews.current;
    setDialogue({
      review,
      title: 'settings.expiry.title',
      submit: 'settings.expiry.apply',
      content: { kind: 'loading' },
    });
    void section.reviewDefaultExpiry(expiresAt).then((outcome) => {
      setDialogue((open) =>
        open?.review !== review
          ? open
          : {
              ...open,
              content: outcome.ok
                ? {
                    kind: 'ready',
                    consequence: (
                      <p>
                        {outcome.value.resolvedExpiresAt === null
                          ? translate('settings.expiry.consequenceNone')
                          : translate(
                              'settings.expiry.consequence',
                              expiryDisplay(outcome.value.resolvedExpiresAt),
                            )}
                      </p>
                    ),
                    confirmation: {
                      phrase: outcome.value.confirmation,
                      confirm: async (typed) => {
                        const failure = await section.applyDefaultExpiry(
                          expiresAt,
                          settings.revision,
                          typed,
                        );
                        if (failure === null) onStatus(translate('settings.expiry.done'));
                        return failure;
                      },
                    },
                  }
                : { kind: 'failed', failure: outcome.failure },
            },
      );
    });
  };

  return (
    <>
      <fieldset className="df-panel__block" aria-labelledby={legendId}>
        <legend id={legendId} className="df-panel__subheading">
          {translate('settings.download.heading')}
        </legend>
        {(['inherit', 'allow', 'deny'] as const).map((value) => (
          <label key={value} className="df-field__choice">
            <input
              type="radio"
              name={legendId}
              value={value}
              checked={choice === value}
              onChange={() => {
                setChoice(value);
              }}
            />
            {value === 'inherit'
              ? translate('settings.download.inherit', { policy: installation })
              : translate(
                  value === 'allow' ? 'settings.download.allow' : 'settings.download.deny',
                )}
          </label>
        ))}
        <p className="df-field__help">
          {translate('settings.download.exceptions', { count: overrideCount })}
        </p>
        <div className="df-panel__actions">
          <button
            type="button"
            className="df-button"
            disabled={choice === current}
            onClick={saveDownloads}
          >
            {translate('settings.download.save')}
          </button>
        </div>
      </fieldset>

      <form
        className="df-panel__block"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (expiry.ok) reviewExpiry(expiry.expiresAt);
        }}
      >
        <h3 className="df-panel__subheading">{translate('settings.expiry.heading')}</h3>
        <p>
          {settings.defaultGrantExpiresAt === null
            ? translate('settings.expiry.none')
            : translate(
                'settings.expiry.current',
                expiryDisplay(settings.defaultGrantExpiresAt),
              )}
        </p>
        <div className="df-field">
          <label className="df-field__label" htmlFor={expiryField}>
            {translate('settings.expiry.label')}
          </label>
          <input
            id={expiryField}
            type="date"
            className="df-field__input"
            value={expiresOn}
            aria-invalid={rejected ? 'true' : undefined}
            aria-describedby={rejected ? `${expiryField}-error` : `${expiryField}-help`}
            onChange={(event) => {
              setExpiresOn(event.target.value);
            }}
          />
          <p className="df-field__help" id={`${expiryField}-help`}>
            {translate('settings.expiry.help')}
          </p>
          {/* Said beside the field rather than left as a dead button: the server refuses a
              past or impossible date with a 400, and a reason shown here is one the member
              can act on. */}
          {rejected ? (
            <p className="df-field__error" id={`${expiryField}-error`} role="alert">
              {translate('settings.expiry.invalid')}
            </p>
          ) : null}
        </div>
        <div className="df-panel__actions">
          <button type="submit" className="df-button" disabled={!expiry.ok}>
            {translate('settings.expiry.review')}
          </button>
        </div>
      </form>

      <ConfirmationDialog
        open={dialogue !== null}
        title={dialogue === null ? '' : translate(dialogue.title)}
        submitLabel={dialogue === null ? '' : translate(dialogue.submit)}
        pendingLabel={translate('settings.pending')}
        content={dialogue?.content ?? { kind: 'loading' }}
        onClose={() => {
          setDialogue(null);
        }}
        onReload={section.reload}
      />
    </>
  );
}
