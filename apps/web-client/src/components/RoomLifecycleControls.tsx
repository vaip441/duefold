/**
 * Audit retention and whole-room purge (§15.4, §15.5).
 *
 * Owner-only and freshly authenticated, each reviewed before it is typed. Retention shows
 * its current value always and explains, from server facts, why it cannot change here.
 * Purge appears only for an archived room or a room that already holds one, and a live
 * purge is stated with its exact instant.
 */
import { useId, useRef, useState } from 'react';
import { CANCEL_PURGE_PHRASE, type RoomSettings } from '../api/client.ts';
import { translate, translateCount, type MessageKey } from '../i18n/translate.ts';
import { expiryDisplay, formatByteSize } from '../workspace/room-settings.ts';
import type { RoomSettingsSection } from '../workspace/useRoomSettings.ts';
import { ConfirmationDialog, type ConfirmationContent } from './ConfirmationDialog.tsx';
import { Notice } from './Notice.tsx';

interface Dialogue {
  readonly review: number;
  readonly kind: 'retention' | 'schedule' | 'cancel';
  readonly content: ConfirmationContent;
}

const COPY: Readonly<
  Record<Dialogue['kind'], { readonly title: MessageKey; readonly submit: MessageKey }>
> = {
  retention: { title: 'settings.retention.title', submit: 'settings.retention.apply' },
  schedule: { title: 'settings.purge.title', submit: 'settings.purge.schedule' },
  cancel: { title: 'settings.purge.cancelTitle', submit: 'settings.purge.cancel' },
};

const PURGE_STATUS: Readonly<Record<NonNullable<RoomSettings['purge']>['state'], MessageKey>> =
  {
    scheduled: 'settings.purge.status.scheduled',
    marker_pending: 'settings.purge.status.running',
    purging: 'settings.purge.status.running',
    purged: 'settings.purge.status.purged',
    failed: 'settings.purge.status.failed',
  };

export interface RoomLifecycleControlsProps {
  readonly settings: RoomSettings;
  readonly section: RoomSettingsSection;
  readonly onStatus: (message: string) => void;
}

export function RoomLifecycleControls({
  settings,
  section,
  onStatus,
}: RoomLifecycleControlsProps): React.ReactElement {
  const yearsField = useId();
  const [years, setYears] = useState(settings.auditRetentionYears);
  const [dialogue, setDialogue] = useState<Dialogue | null>(null);
  const reviews = useRef(0);
  const capabilities = settings.capabilities;
  const freshNote = (
    <p className="df-field__help">{translate('settings.lifecycle.freshSignIn')}</p>
  );

  const reviewRetention = (): void => {
    reviews.current += 1;
    const reviewId = reviews.current;
    setDialogue({ review: reviewId, kind: 'retention', content: { kind: 'loading' } });
    void section.reviewRetention(years).then((outcome) => {
      setDialogue((open) =>
        open?.review !== reviewId
          ? open
          : {
              review: reviewId,
              kind: 'retention',
              content: outcome.ok
                ? {
                    kind: 'ready',
                    consequence: (
                      <>
                        <p>
                          {translateCount(
                            'settings.retention.consequence',
                            outcome.value.proposedYears,
                            { years: outcome.value.proposedYears },
                          )}
                        </p>
                        {freshNote}
                      </>
                    ),
                    confirmation: {
                      phrase: outcome.value.confirmation,
                      confirm: async (typed) => {
                        const failure = await section.applyRetention(
                          years,
                          settings.revision,
                          typed,
                        );
                        if (failure === null) onStatus(translate('settings.retention.done'));
                        return failure;
                      },
                    },
                  }
                : { kind: 'failed', failure: outcome.failure },
            },
      );
    });
  };

  const reviewPurge = (): void => {
    reviews.current += 1;
    const reviewId = reviews.current;
    setDialogue({ review: reviewId, kind: 'schedule', content: { kind: 'loading' } });
    void section.reviewPurge().then((outcome) => {
      setDialogue((open) =>
        open?.review !== reviewId
          ? open
          : {
              review: reviewId,
              kind: 'schedule',
              content: outcome.ok
                ? {
                    kind: 'ready',
                    consequence: (
                      <>
                        <p>{translate('settings.purge.consequence')}</p>
                        <p>
                          {translate('settings.purge.counts', {
                            documents: outcome.value.documentCount,
                            viewers: outcome.value.viewerCount,
                            size: formatByteSize(outcome.value.sourceBytes),
                          })}
                        </p>
                        {freshNote}
                      </>
                    ),
                    confirmation: {
                      phrase: outcome.value.confirmation,
                      confirm: async (typed) => {
                        const failure = await section.schedulePurge(settings.revision, typed);
                        if (failure === null) onStatus(translate('settings.purge.scheduled'));
                        return failure;
                      },
                    },
                  }
                : { kind: 'failed', failure: outcome.failure },
            },
      );
    });
  };

  const beginCancel = (purgeId: string): void => {
    reviews.current += 1;
    const reviewId = reviews.current;
    setDialogue({
      review: reviewId,
      kind: 'cancel',
      content: {
        kind: 'ready',
        consequence: <p>{translate('settings.purge.cancelConsequence')}</p>,
        confirmation: {
          phrase: CANCEL_PURGE_PHRASE,
          confirm: async () => {
            const failure = await section.cancelPurge(purgeId);
            if (failure === null) onStatus(translate('settings.purge.cancelled'));
            return failure;
          },
        },
      },
    });
  };

  const purge = settings.purge;
  const showPurge = settings.state === 'archived' || purge !== null;

  return (
    <>
      <div className="df-panel__block">
        <h3 className="df-panel__subheading">{translate('settings.retention.heading')}</h3>
        <p>
          {translateCount('settings.retention.current', settings.auditRetentionYears, {
            years: settings.auditRetentionYears,
          })}
        </p>
        {capabilities.setRetention ? (
          <>
            <div className="df-field">
              <label className="df-field__label" htmlFor={yearsField}>
                {translate('settings.retention.label')}
              </label>
              <select
                id={yearsField}
                className="df-field__input"
                value={years}
                onChange={(event) => {
                  setYears(Number(event.target.value));
                }}
              >
                {Array.from({ length: 10 }, (_, index) => index + 1).map((value) => (
                  <option key={value} value={value}>
                    {translateCount('settings.retention.years', value, { years: value })}
                  </option>
                ))}
              </select>
            </div>
            <div className="df-panel__actions">
              <button
                type="button"
                className="df-button"
                disabled={years === settings.auditRetentionYears}
                onClick={reviewRetention}
              >
                {translate('settings.retention.review')}
              </button>
            </div>
          </>
        ) : (
          <p className="df-field__help">
            {translate(
              settings.state === 'draft'
                ? 'settings.retention.ownerOnly'
                : 'settings.retention.locked',
            )}
          </p>
        )}
      </div>

      {showPurge ? (
        <div className="df-panel__block">
          <h3 className="df-panel__subheading">{translate('settings.purge.heading')}</h3>
          {purge === null ? (
            <p>{translate('settings.purge.none')}</p>
          ) : (
            <Notice tone="caution" role="status">
              {translate(PURGE_STATUS[purge.state], expiryDisplay(purge.purgeAfter))}
            </Notice>
          )}
          <div className="df-panel__actions">
            {capabilities.schedulePurge ? (
              <button type="button" className="df-button" onClick={reviewPurge}>
                {translate('settings.purge.schedule')}
              </button>
            ) : null}
            {capabilities.cancelPurge && purge !== null ? (
              <button
                type="button"
                className="df-button"
                onClick={() => {
                  beginCancel(purge.purgeId);
                }}
              >
                {translate('settings.purge.cancel')}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <ConfirmationDialog
        open={dialogue !== null}
        title={dialogue === null ? '' : translate(COPY[dialogue.kind].title)}
        submitLabel={dialogue === null ? '' : translate(COPY[dialogue.kind].submit)}
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
