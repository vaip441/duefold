/**
 * App shell structure tests.
 *
 * The shell's accessibility contract is structural, so it is asserted on rendered
 * markup rather than described in a comment. Retrofitting landmarks across many
 * surfaces later is far more expensive than pinning them now.
 *
 * Rendering uses `react-dom/server`, which exercises the real component tree
 * without adding a DOM environment dependency. Behavioural and focus assertions
 * live in the Playwright suite, where a real browser can make them.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppShell, type CollectionEntry } from './AppShell.tsx';

const ENTRIES: readonly CollectionEntry[] = [
  { id: 'one', title: 'Corporate', depth: 0 },
  { id: 'two', title: 'Articles of association', depth: 1 },
];

function render(overrides: Partial<Parameters<typeof AppShell>[0]> = {}): string {
  return renderToStaticMarkup(
    <AppShell
      title="Duefold"
      pageTitle="app.name"
      entries={[]}
      currentEntryId={null}
      onSelectEntry={() => undefined}
      indexEmpty={{
        lead: 'No rooms yet.',
        help: 'A room appears here once one is created.',
      }}
      status=""
      notes="Viewers cannot reach anything in this room."
      {...overrides}
    />,
  );
}

describe('landmark regions', () => {
  it('renders every shell region as a landmark', () => {
    const markup = render();
    expect(markup).toContain('<header');
    expect(markup).toContain('<nav');
    expect(markup).toContain('<main');
    expect(markup).toContain('<aside');
    expect(markup).not.toContain('<footer');
  });

  it('names each region so a landmark list is navigable', () => {
    const markup = render();
    // The index and notes regions are labelled by their headings; the
    // room-facts banner carries an explicit label because its heading is the wordmark.
    expect(markup).toMatch(/<nav class="df-index" aria-labelledby="[^"]+"/u);
    expect(markup).toMatch(/<aside class="df-notes" aria-labelledby="[^"]+"/u);
    expect(markup).toMatch(/<header class="df-facts" aria-label="[^"]+"/u);
  });

  it('renders the Duefold brand logo mark and wordmark in the facts header', () => {
    const markup = render();
    expect(markup).toContain('class="df-brand-identity"');
    expect(markup).toContain('class="df-brand-identity__mark"');
    expect(markup).toContain('class="df-facts__wordmark"');
    expect(markup).toContain('Duefold');
    // The brand mark is aria-hidden so screen readers hear the clean wordmark text
    expect(markup).toContain('aria-hidden="true"');
  });

  it('renders exactly one h1, in the worktable', () => {
    const markup = render({ title: 'Series A room' });
    expect([...markup.matchAll(/<h1/gu)]).toHaveLength(1);
    expect(markup).toContain('<h1 class="df-worktable__title">Series A room</h1>');
    // Region labels are h2, never a second h1.
    expect([...markup.matchAll(/<h2/gu)].length).toBeGreaterThanOrEqual(2);
  });

  it('puts the skip link first in DOM order and targets the worktable', () => {
    const markup = render();
    expect(markup.indexOf('df-skip')).toBeLessThan(markup.indexOf('df-facts'));
    expect(markup).toContain('href="#df-worktable"');
    expect(markup).toContain('id="df-worktable"');
  });

  it('keeps focus order: facts, index, worktable, notes', () => {
    const markup = render();
    // Anchored on the region's opening tag: the skip link mentions the worktable
    // id earlier by design, and that is the target rather than the region.
    const order = [
      '<header class="df-facts"',
      '<nav class="df-index"',
      '<main class="df-worktable"',
      '<aside class="df-notes"',
    ].map((region) => markup.indexOf(region));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toStrictEqual([...order].sort((left, right) => left - right));
  });

  it('exposes one polite live region for asynchronous status', () => {
    const markup = render({ status: 'Signing out…' });
    expect(markup).toMatch(/role="status"[^>]*aria-live="polite"/u);
    expect(markup).toContain('Signing out…');
  });
});

describe('index and worktable relationship', () => {
  it('relates every index entry to the worktable it controls', () => {
    const markup = render({ entries: ENTRIES, currentEntryId: 'two' });
    const controls = [...markup.matchAll(/aria-controls="df-worktable"/gu)];
    // One per entry, so the relationship is programmatic rather than visual.
    expect(controls).toHaveLength(ENTRIES.length);
  });

  it('marks the current entry with aria-current, not colour alone', () => {
    const markup = render({ entries: ENTRIES, currentEntryId: 'two' });
    expect([...markup.matchAll(/aria-current="true"/gu)]).toHaveLength(1);
    const currentIndex = markup.indexOf('aria-current="true"');
    expect(markup.slice(currentIndex, currentIndex + 200)).toContain('Articles of association');
  });

  it('renders index entries as buttons in a list', () => {
    const markup = render({ entries: ENTRIES, currentEntryId: null });
    expect(markup).toContain('<ul class="df-index__tree"');
    expect([...markup.matchAll(/class="df-index__entry"/gu)]).toHaveLength(ENTRIES.length);
  });

  it('exposes the narrow-viewport index disclosure with its expanded state', () => {
    const markup = render({ entries: ENTRIES, currentEntryId: null });
    expect(markup).toMatch(/aria-expanded="true"[^>]*aria-controls="[^"]+"/u);
  });
});

describe('honest empty states', () => {
  it('teaches the collection region when no rooms exist', () => {
    const markup = render();
    expect(markup).toContain('No rooms yet.');
    expect(markup).toContain('A room appears here once one is created.');
  });

  it('renders a context-specific collection empty state when provided', () => {
    const markup = render({
      indexEmpty: {
        lead: 'This room has no folders or documents yet.',
        help: 'Create a folder to begin organizing the collection.',
      },
    });
    expect(markup).toContain('This room has no folders or documents yet.');
    expect(markup).toContain('Create a folder to begin organizing the collection.');
    expect(markup).not.toContain('No rooms yet.');
  });

  it('teaches the worktable when nothing is selected', () => {
    const markup = render();
    expect(markup).toContain('Nothing selected.');
    expect(markup).toContain('Choose an entry in the collection to begin.');
  });

  it('never invents counterparties', () => {
    const markup = render();
    expect(markup).not.toContain('Counterparties');
    expect(markup).not.toContain('No counterparties yet.');
  });

  it('draws no notes margin when the view has nothing to note', () => {
    // A placeholder sentence in a reserved column only narrowed the worktable.
    const markup = render({ notes: undefined });
    expect(markup).not.toContain('<aside');
    expect(markup).toContain('data-notes="false"');
  });

  it('invents no content: an empty shell shows no room, document, or person', () => {
    // A placeholder a later surface must tear out would show up here.
    const markup = render();
    expect(markup).not.toMatch(/lorem|example\.com|placeholder|Acme|TODO/iu);
  });
});

describe('leak resistance', () => {
  it('renders only the display title, never a path or internal identifier', () => {
    const markup = render({
      entries: [{ id: 'opaque-id-value', title: 'Articles of association', depth: 0 }],
      currentEntryId: null,
    });
    expect(markup).toContain('Articles of association');
    // The entry id is a React key and callback argument; it must not be printed.
    expect(markup).not.toContain('opaque-id-value');
  });

  it('exposes no module, provider, or composition detail', () => {
    const markup = render();
    expect(markup).not.toMatch(/module|manifest|s3|postgres|smtp|oidc|clamav/iu);
  });
});
