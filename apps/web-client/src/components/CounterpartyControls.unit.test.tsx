import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Counterparty, Participant, WorkingEntry } from '../api/client.ts';
import { messages } from '../i18n/en.ts';
import type { ParticipantsSection } from '../workspace/useParticipantsSection.ts';
import { CounterpartyControls, CounterpartyTables } from './CounterpartyControls.tsx';

const buyer: Counterparty = {
  counterpartyId: 'c'.repeat(32),
  name: 'Buyer A',
  revision: 1,
  viewerCount: 0,
};

const reader = (
  counterpartyName: string | null,
  email = 'reader@example.test',
): Participant => ({
  viewerId: email.padEnd(32, 'v').slice(0, 32),
  email,
  membershipState: 'active',
  membershipRevision: 1,
  counterpartyId: counterpartyName === null ? null : buyer.counterpartyId,
  counterpartyName,
  grants: [],
});

const noop = (): void => undefined;

const mockSection: ParticipantsSection = {
  roster: { kind: 'loading' },
  failure: null,
  inviteFailure: null,
  invitePending: false,
  impact: null,
  impactPending: false,
  applyPending: false,
  changeFailure: null,
  refresh: noop,
  beginLoading: noop,
  invite: noop,
  review: noop,
  apply: noop,
  cancelChange: noop,
  previewGrant: () => Promise.reject(new Error('not called')),
  commitGrant: () => Promise.resolve(null),
  addCounterparty: () => Promise.resolve(null),
  placeViewer: () => Promise.resolve(null),
  removeViewer: () => Promise.resolve(null),
};

const tables = (
  participants: readonly Participant[],
  counterparties: readonly Counterparty[] = [buyer],
) =>
  renderToStaticMarkup(
    <CounterpartyTables
      roster={{ participants, counterparties }}
      chosen={{}}
      onChoose={noop}
      onPlace={noop}
      onRemove={noop}
      onGrant={noop}
    />,
  );

const controls = (
  counterparties: readonly Counterparty[] = [buyer],
  participants: readonly Participant[] = [],
  entries: readonly WorkingEntry[] = [],
) =>
  renderToStaticMarkup(
    <CounterpartyControls
      roomId={'r'.repeat(32)}
      roomRevision={1}
      roster={{ participants, counterparties }}
      entries={entries}
      section={mockSection}
      onStatus={noop}
    />,
  );

describe('CounterpartyTables', () => {
  it('lists a counterparty nobody is placed in', () => {
    expect(tables([])).toContain('Buyer A');
  });

  it('offers placement only to a reader in no counterparty, and removal only to one in a counterparty', () => {
    expect(tables([reader(null)])).toContain(messages['counterparty.place']);
    expect(tables([reader('Buyer A')])).not.toContain(messages['counterparty.place']);
    expect(tables([reader('Buyer A')])).toContain('Remove from Buyer A');
  });

  it('offers no placement when the room has no counterparties', () => {
    expect(tables([reader(null)], [])).not.toContain(messages['counterparty.place']);
  });
});

describe('CounterpartyControls', () => {
  it('renders heading, explanation, and empty counterparties note when none exist', () => {
    const html = controls([]);
    expect(html).toContain(messages['counterparty.heading']);
    expect(html).toContain(messages['counterparty.explain']);
    expect(html).toContain(messages['counterparty.none']);
  });

  it('binds the name field to its label, so the control has an accessible name', () => {
    const html = controls();
    expect(html).toContain(messages['counterparty.create']);
    /* The id the label points at must be the id the input carries. Asserting only that some
       input has some id passes even when the label points somewhere else entirely. */
    const labelled = /<label[^>]+for="([^"]+)"/u.exec(html)?.[1];
    expect(labelled).toBeDefined();
    expect(html).toMatch(new RegExp(`<input[^>]+id="${labelled ?? ''}"`, 'u'));
  });

  /* Each reader's select is one of several on the page, so its accessible name has to name the
     reader. A shared label would leave a screen-reader user choosing blind. */
  it('names each reader in the accessible name of their own placement control', () => {
    const html = tables([
      reader(null, 'first@example.com'),
      reader(null, 'second@example.com'),
    ]);
    expect(html).toContain('aria-label="Counterparty for first@example.com"');
    expect(html).toContain('aria-label="Counterparty for second@example.com"');
  });

  it('states what a counterparty is before offering to create one', () => {
    const html = controls([]);
    /* The explanation precedes the field: a group whose consequence is unstated invites a
       Manager to create one and find out what it did afterwards. */
    expect(html.indexOf(messages['counterparty.explain'])).toBeLessThan(
      html.indexOf(messages['counterparty.create']),
    );
  });
});
