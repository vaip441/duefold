/**
 * Counterparties: the firms readers belong to, where each reader sits, and grants that
 * reach a whole counterparty (§9.1).
 *
 * Creating a counterparty grants nothing and submits directly. Placing a reader, removing
 * one, and granting a counterparty all change access and open the confirmation dialog on
 * their consequence; a counterparty grant is reviewed by the server and typed, and needs a
 * fresh sign-in because it is broad.
 */
import { useId, useRef, useState, type ReactElement } from 'react';
import type {
  Counterparty,
  GrantImpact,
  ParticipantRoster,
  WorkingEntry,
} from '../api/client.ts';
import { translate } from '../i18n/translate.ts';
import type { PresentedFailure } from '../workspace/failures.ts';
import {
  counterpartyNameTaken,
  grantableTargets,
  validateGrantDraft,
  type GrantDraft,
  type GrantSubmission,
} from '../workspace/grants.ts';
import type { ParticipantsSection } from '../workspace/useParticipantsSection.ts';
import { ConfirmationDialog, type ConfirmationContent } from './ConfirmationDialog.tsx';
import { FailureNotice } from './FailureNotice.tsx';
import { GrantDraftFields } from './GrantDraftFields.tsx';

const EMPTY_DRAFT: GrantDraft = {
  changeAction: 'grant',
  targetKind: null,
  folderId: null,
  documentId: null,
  expiresOn: '',
};

export interface CounterpartyTablesProps {
  readonly roster: ParticipantRoster;
  /** The counterparty chosen in each unplaced reader's select, by viewer id. */
  readonly chosen: Readonly<Record<string, string>>;
  readonly onChoose: (viewerId: string, counterpartyId: string) => void;
  readonly onPlace: (viewerId: string, email: string, counterparty: Counterparty) => void;
  readonly onRemove: (viewerId: string, email: string, counterpartyName: string) => void;
  readonly onGrant: (counterparty: Counterparty) => void;
}

export function CounterpartyTables({
  roster,
  chosen,
  onChoose,
  onPlace,
  onRemove,
  onGrant,
}: CounterpartyTablesProps): ReactElement {
  const { counterparties } = roster;
  const readers = roster.participants.filter(
    (participant) => participant.membershipState === 'active',
  );
  return (
    <>
      {counterparties.length === 0 ? (
        <p className="df-field__help">{translate('counterparty.none')}</p>
      ) : (
        <table className="df-register">
          <caption>{translate('counterparty.caption')}</caption>
          <thead>
            <tr>
              <th scope="col">{translate('counterparty.columns.name')}</th>
              <th scope="col">{translate('counterparty.columns.readers')}</th>
              <th scope="col">{translate('counterparty.columns.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {counterparties.map((counterparty) => (
              <tr key={counterparty.counterpartyId}>
                <th scope="row">{counterparty.name}</th>
                <td data-numeric="true">{counterparty.viewerCount}</td>
                <td>
                  <button
                    type="button"
                    className="df-button"
                    onClick={() => {
                      onGrant(counterparty);
                    }}
                  >
                    {translate('counterparty.grant', { name: counterparty.name })}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Withheld until the room has a counterparty to place anyone in: a placement table with
          an empty choice offers nothing and repeats the reader list above it for no purpose. */}
      {counterparties.length === 0 || readers.length === 0 ? null : (
        <table className="df-register">
          <caption>{translate('counterparty.placement.caption')}</caption>
          <thead>
            <tr>
              <th scope="col">{translate('counterparty.placement.reader')}</th>
              <th scope="col">{translate('counterparty.placement.counterparty')}</th>
              <th scope="col">{translate('counterparty.columns.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {readers.map((reader) => {
              const placedIn = reader.counterpartyName;
              const choice =
                counterparties.find((c) => c.counterpartyId === chosen[reader.viewerId]) ??
                counterparties[0];
              return (
                <tr key={reader.viewerId}>
                  <th scope="row">{reader.email}</th>
                  <td>{placedIn ?? translate('counterparty.placement.none')}</td>
                  <td>
                    {placedIn !== null ? (
                      <button
                        type="button"
                        className="df-button"
                        onClick={() => {
                          onRemove(reader.viewerId, reader.email, placedIn);
                        }}
                      >
                        {translate('counterparty.remove', { name: placedIn })}
                      </button>
                    ) : choice === undefined ? null : (
                      <>
                        <select
                          className="df-field__input"
                          aria-label={translate('counterparty.placement.choose', {
                            email: reader.email,
                          })}
                          value={choice.counterpartyId}
                          onChange={(event) => {
                            onChoose(reader.viewerId, event.target.value);
                          }}
                        >
                          {counterparties.map((c) => (
                            <option key={c.counterpartyId} value={c.counterpartyId}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="df-button"
                          onClick={() => {
                            onPlace(reader.viewerId, reader.email, choice);
                          }}
                        >
                          {translate('counterparty.place')}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

export interface CounterpartyControlsProps {
  readonly roomId: string;
  readonly roomRevision: number;
  readonly roster: ParticipantRoster;
  readonly entries: readonly WorkingEntry[];
  readonly section: ParticipantsSection;
  readonly onStatus: (message: string) => void;
}

export function CounterpartyControls({
  roomId,
  roomRevision,
  roster,
  entries,
  section,
  onStatus,
}: CounterpartyControlsProps): ReactElement {
  const headingId = useId();
  const nameField = useId();
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createFailure, setCreateFailure] = useState<PresentedFailure | null>(null);
  const [chosen, setChosen] = useState<Readonly<Record<string, string>>>({});
  const [granting, setGranting] = useState<{
    readonly counterparty: Counterparty;
    readonly draft: GrantDraft;
  } | null>(null);
  const [dialogue, setDialogue] = useState<{
    readonly review: number;
    readonly title: string;
    readonly submit: string;
    readonly content: ConfirmationContent;
  } | null>(null);
  const reviews = useRef(0);
  const taken = counterpartyNameTaken(name, roster.counterparties);

  const create = async (): Promise<void> => {
    const trimmed = name.trim();
    setCreating(true);
    setCreateFailure(null);
    const failure = await section.addCounterparty({
      roomId,
      name: trimmed,
      expectedRoomRevision: roomRevision,
    });
    setCreating(false);
    if (failure === null) {
      onStatus(translate('counterparty.created', { name: trimmed }));
      setName('');
    } else setCreateFailure(failure);
  };

  const confirmAccessChange = (
    title: string,
    submit: string,
    consequence: string,
    run: () => Promise<PresentedFailure | null>,
    done: string,
  ): void => {
    reviews.current += 1;
    const reviewId = reviews.current;
    setDialogue({
      review: reviewId,
      title,
      submit,
      content: {
        kind: 'ready',
        consequence: <p>{consequence}</p>,
        confirmation: {
          phrase: null,
          confirm: async () => {
            const failure = await run();
            if (failure === null) onStatus(done);
            return failure;
          },
        },
      },
    });
  };

  const reviewGrant = (counterparty: Counterparty, draft: GrantDraft): void => {
    reviews.current += 1;
    const reviewId = reviews.current;
    const submission: GrantSubmission = {
      grantee: {
        kind: 'counterparty',
        counterpartyId: counterparty.counterpartyId,
        label: counterparty.name,
      },
      draft,
    };
    const title = translate('counterparty.grant.title', { name: counterparty.name });
    setDialogue({
      review: reviewId,
      title,
      submit: translate('counterparty.grant.apply'),
      content: { kind: 'loading' },
    });
    void section.previewGrant(roomId, submission).then((outcome) => {
      setDialogue((open) =>
        open?.review !== reviewId
          ? open
          : {
              ...open,
              content: outcome.ok
                ? {
                    kind: 'ready',
                    consequence: (
                      <GrantConsequence impact={outcome.value} counterparty={counterparty} />
                    ),
                    confirmation: {
                      phrase: outcome.value.confirmation,
                      confirm: async (typed) => {
                        const failure = await section.commitGrant({
                          roomId,
                          submission,
                          impact: outcome.value,
                          expectedRoomRevision: roomRevision,
                          confirmation: typed,
                        });
                        if (failure === null) setGranting(null);
                        return failure;
                      },
                    },
                  }
                : { kind: 'failed', failure: outcome.failure },
            },
      );
    });
  };

  const folders = grantableTargets(entries, 'folder');
  const documents = grantableTargets(entries, 'document');
  const problems = granting === null ? [] : validateGrantDraft(granting.draft, new Date());

  return (
    <section className="df-panel__block" aria-labelledby={headingId}>
      <h3 id={headingId} className="df-panel__subheading">
        {translate('counterparty.heading')}
      </h3>
      <p className="df-field__help">{translate('counterparty.explain')}</p>

      <CounterpartyTables
        roster={roster}
        chosen={chosen}
        onChoose={(viewerId, counterpartyId) => {
          setChosen((current) => ({ ...current, [viewerId]: counterpartyId }));
        }}
        onPlace={(viewerId, email, counterparty) => {
          confirmAccessChange(
            translate('counterparty.place.title'),
            translate('counterparty.place'),
            translate('counterparty.place.consequence', { email, name: counterparty.name }),
            () =>
              section.placeViewer({
                roomId,
                counterpartyId: counterparty.counterpartyId,
                viewerId,
                expectedRoomRevision: roomRevision,
              }),
            translate('counterparty.placed', { name: counterparty.name }),
          );
        }}
        onRemove={(viewerId, email, counterpartyName) => {
          confirmAccessChange(
            translate('counterparty.remove.title'),
            translate('counterparty.remove', { name: counterpartyName }),
            translate('counterparty.remove.consequence', { email, name: counterpartyName }),
            () =>
              section.removeViewer({ roomId, viewerId, expectedRoomRevision: roomRevision }),
            translate('counterparty.removed', { name: counterpartyName }),
          );
        }}
        onGrant={(counterparty) => {
          setGranting({ counterparty, draft: EMPTY_DRAFT });
        }}
      />

      {granting === null ? null : (
        <div className="df-panel__block" data-grant-form="true">
          <h4 className="df-panel__subheading">
            {translate('counterparty.grant', { name: granting.counterparty.name })}
          </h4>
          <GrantDraftFields
            draft={granting.draft}
            problems={problems}
            folders={folders}
            documents={documents}
            onDraftChange={(draft) => {
              setGranting({ ...granting, draft });
            }}
          />
          <div className="df-panel__actions">
            <button
              type="button"
              className="df-button"
              onClick={() => {
                setGranting(null);
              }}
            >
              {translate('structure.cancel')}
            </button>
            <button
              type="button"
              className="df-button df-button--primary"
              disabled={problems.length > 0}
              onClick={() => {
                reviewGrant(granting.counterparty, granting.draft);
              }}
            >
              {translate('counterparty.grant.review')}
            </button>
          </div>
        </div>
      )}

      <form
        className="df-inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!creating && name.trim() !== '' && !taken) void create();
        }}
      >
        <div className="df-field">
          <label className="df-field__label" htmlFor={nameField}>
            {translate('counterparty.name')}
          </label>
          <input
            id={nameField}
            className="df-field__input"
            maxLength={200}
            value={name}
            disabled={creating}
            aria-invalid={taken ? 'true' : undefined}
            aria-describedby={taken ? `${nameField}-error` : undefined}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          {taken ? (
            <p className="df-field__error" id={`${nameField}-error`} role="alert">
              {translate('counterparty.nameTaken')}
            </p>
          ) : null}
        </div>
        <button
          type="submit"
          className="df-button"
          disabled={creating || name.trim() === '' || taken}
        >
          {creating ? translate('counterparty.creating') : translate('counterparty.create')}
        </button>
        {createFailure === null ? null : (
          <FailureNotice
            failure={createFailure}
            onReload={() => {
              section.refresh(roomId);
            }}
          />
        )}
      </form>

      <ConfirmationDialog
        open={dialogue !== null}
        title={dialogue?.title ?? ''}
        submitLabel={dialogue?.submit ?? ''}
        pendingLabel={translate('settings.pending')}
        content={dialogue?.content ?? { kind: 'loading' }}
        onClose={() => {
          setDialogue(null);
        }}
        onReload={() => {
          section.refresh(roomId);
        }}
      />
    </section>
  );
}

function GrantConsequence({
  impact,
  counterparty,
}: {
  readonly impact: GrantImpact;
  readonly counterparty: Counterparty;
}): ReactElement {
  return (
    <>
      {/* The server's own sentence is deliberately NOT rendered: copy is this application's,
          in one catalogue, translatable, and the individual grant surface does the same. */}
      <p>
        {translate('counterparty.grant.reach', {
          name: counterparty.name,
          readers: counterparty.viewerCount,
        })}
      </p>
      {impact.paths.length === 0 ? null : (
        <ul>
          {impact.paths.map((path) => (
            <li key={path}>{path}</li>
          ))}
        </ul>
      )}
      <p className="df-field__help">{translate('counterparty.grant.freshSignIn')}</p>
    </>
  );
}
