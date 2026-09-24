/**
 * Publish, archive, return to draft — each offered only where its capability is true.
 *
 * Publishing and archiving open the dialog on the server's review; returning to draft is
 * the kill switch and opens it on a stated consequence with no phrase. A review that
 * resolves after its dialog was closed or replaced is dropped.
 */
import { useRef, useState } from 'react';
import type {
  RoomSettings,
  RoomState,
  VisibilityChange,
  VisibilityImpact,
} from '../api/client.ts';
import { translate, type MessageKey } from '../i18n/translate.ts';
import type { PresentedFailure } from '../workspace/failures.ts';
import { visibilityNotes } from '../workspace/room-settings.ts';
import type { RoomSettingsSection } from '../workspace/useRoomSettings.ts';
import { ConfirmationDialog, type ConfirmationContent } from './ConfirmationDialog.tsx';

const STATE_COPY: Readonly<
  Record<RoomState, { readonly name: MessageKey; readonly explain: MessageKey }>
> = {
  draft: { name: 'rooms.state.draft', explain: 'rooms.state.draft.explain' },
  published: { name: 'rooms.state.published', explain: 'rooms.state.published.explain' },
  archived: { name: 'rooms.state.archived', explain: 'rooms.state.archived.explain' },
};

const COPY: Readonly<
  Record<
    RoomState,
    { readonly action: MessageKey; readonly title: MessageKey; readonly done: MessageKey }
  >
> = {
  published: {
    action: 'settings.visibility.publish',
    title: 'settings.visibility.publish.title',
    done: 'settings.visibility.done.published',
  },
  archived: {
    action: 'settings.visibility.archive',
    title: 'settings.visibility.archive.title',
    done: 'settings.visibility.done.archived',
  },
  draft: {
    action: 'settings.visibility.returnToDraft',
    title: 'settings.visibility.draft.title',
    done: 'settings.visibility.done.draft',
  },
};

function VisibilityConsequence({
  impact,
}: {
  readonly impact: VisibilityImpact;
}): React.ReactElement {
  const values = { viewers: impact.viewerCount, documents: impact.publishedDocumentCount };
  return (
    <>
      <p>
        {impact.proposedState === 'published'
          ? translate('settings.visibility.publish.consequence', values)
          : translate('settings.visibility.archive.consequence', values)}
      </p>
      {impact.requiresFreshAuthentication ? (
        <p className="df-field__help">{translate('settings.visibility.freshSignIn')}</p>
      ) : null}
    </>
  );
}

export interface RoomVisibilityControlsProps {
  readonly settings: RoomSettings;
  readonly section: RoomSettingsSection;
  readonly onStatus: (message: string) => void;
}

export function RoomVisibilityControls({
  settings,
  section,
  onStatus,
}: RoomVisibilityControlsProps): React.ReactElement {
  const [dialogue, setDialogue] = useState<{
    readonly review: number;
    readonly state: RoomState;
    readonly content: ConfirmationContent;
  } | null>(null);
  /* Every opening is its own review. Keying by state alone let a slow first response replace
     the impact of a second opening of the SAME transition, so the Manager would confirm
     against counts and an expected revision that were already superseded. */
  const reviews = useRef(0);
  const capabilities = settings.capabilities;

  const finish = async (change: VisibilityChange): Promise<PresentedFailure | null> => {
    const failure = await section.applyVisibility(change);
    if (failure === null) onStatus(translate(COPY[change.state].done));
    return failure;
  };

  const begin = (state: RoomState): void => {
    reviews.current += 1;
    const review = reviews.current;
    if (state === 'draft') {
      setDialogue({
        review,
        state,
        content: {
          kind: 'ready',
          consequence: <p>{translate('settings.visibility.draft.consequence')}</p>,
          confirmation: {
            phrase: null,
            confirm: () => finish({ state: 'draft', expectedRevision: settings.revision }),
          },
        },
      });
      return;
    }
    setDialogue({ review, state, content: { kind: 'loading' } });
    void section.reviewVisibility(state).then((outcome) => {
      setDialogue((current) =>
        current?.review !== review
          ? current
          : {
              review,
              state,
              content: outcome.ok
                ? {
                    kind: 'ready',
                    consequence: <VisibilityConsequence impact={outcome.value} />,
                    confirmation: {
                      phrase: outcome.value.confirmation,
                      confirm: (typed) =>
                        finish({
                          state,
                          expectedRevision: outcome.value.expectedRevision,
                          confirmation: typed,
                        }),
                    },
                  }
                : { kind: 'failed', failure: outcome.failure },
            },
      );
    });
  };

  const offered: readonly [RoomState, boolean][] = [
    ['published', capabilities.publish],
    ['archived', capabilities.archive],
    ['draft', capabilities.returnToDraft],
  ];

  return (
    <div className="df-panel__block">
      <h3 className="df-panel__subheading">{translate('settings.visibility.heading')}</h3>
      <p>
        <strong>{translate(STATE_COPY[settings.state].name)}</strong> —{' '}
        {translate(STATE_COPY[settings.state].explain)}
      </p>
      {visibilityNotes(settings).map((note) => (
        <p key={note} className="df-field__help">
          {translate(note)}
        </p>
      ))}
      <div className="df-panel__actions">
        {offered
          .filter(([, allowed]) => allowed)
          .map(([state]) => (
            <button
              key={state}
              type="button"
              className="df-button"
              onClick={() => {
                begin(state);
              }}
            >
              {translate(COPY[state].action)}
            </button>
          ))}
      </div>
      <ConfirmationDialog
        open={dialogue !== null}
        title={dialogue === null ? '' : translate(COPY[dialogue.state].title)}
        submitLabel={dialogue === null ? '' : translate(COPY[dialogue.state].action)}
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
