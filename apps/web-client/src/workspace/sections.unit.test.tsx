/**
 * Section composition tests.
 *
 * The property under test is the one invariant 17 rests on for navigation: a section
 * exists because its module was composed, and nothing in the application names a
 * section it does not own. These are pure functions, so the ordering, the fallback,
 * and the omission case are all decidable here rather than only in a real build.
 *
 * The bundle-level proof — that an omitted module's panel, label, and request path
 * are ABSENT from the built artifact — lives in `test/browser/composition.spec.ts`,
 * because only a real build can show it.
 */

import { describe, expect, it } from 'vitest';
import type { RoomSectionContribution, SectionTab } from '../contract.ts';
import { composeSections, currentSection, isContributed } from './sections.ts';

const CORE: readonly SectionTab[] = [
  { id: 'structure', scope: 'room', label: () => 'Collection', order: 10 },
  { id: 'participants', scope: 'room', label: () => 'Access', order: 20 },
];

/* A ROOM contribution specifically: SectionContribution is discriminated by scope, so
   a fixture typed as the union could not be spread over with a partial without
   widening `scope` and losing which render signature applies. */
function contribution(
  overrides: Partial<Omit<RoomSectionContribution, 'scope'>> = {},
): RoomSectionContribution {
  return {
    id: 'branding',
    scope: 'room',
    label: () => 'Branding',
    order: 50,
    render: () => <p>panel</p>,
    ...overrides,
  };
}

describe('composeSections', () => {
  it('composes nothing extra when no module contributed a section', () => {
    // The state a minimal composition produces: the registry is empty, so the strip
    // is exactly core. Nothing is filtered out at runtime, because nothing was there.
    const composed = composeSections(CORE, []);
    expect(composed.map((section) => section.id)).toStrictEqual(['structure', 'participants']);
  });

  it('sorts a contribution into position by order rather than appending it', () => {
    const composed = composeSections(CORE, [contribution({ order: 15 })]);
    expect(composed.map((section) => section.id)).toStrictEqual([
      'structure',
      'branding',
      'participants',
    ]);
  });

  it('breaks an order tie by id so the strip has one stable sequence', () => {
    // Registry sequence is generation order, not a product decision, so it must not
    // decide what a member sees.
    const first = composeSections(CORE, [
      contribution({ id: 'zeta', order: 20 }),
      contribution({ id: 'alpha', order: 20 }),
    ]);
    const reversed = composeSections(CORE, [
      contribution({ id: 'alpha', order: 20 }),
      contribution({ id: 'zeta', order: 20 }),
    ]);
    expect(first.map((section) => section.id)).toStrictEqual(
      reversed.map((section) => section.id),
    );
    expect(first.map((section) => section.id)).toStrictEqual([
      'structure',
      'alpha',
      'participants',
      'zeta',
    ]);
  });

  it('resolves a label through the contributing module, not a shared catalogue', () => {
    // The label is a function so the copy can live in the module that owns it. A key
    // into the application's catalogue would leave the string in a minimal bundle.
    const composed = composeSections([], [contribution({ label: () => 'Branding' })]);
    expect(composed[0]?.label()).toBe('Branding');
  });
});

describe('currentSection', () => {
  it('honours a requested section that the strip contains', () => {
    const composed = composeSections(CORE, [contribution()]);
    expect(currentSection(composed, 'branding')?.id).toBe('branding');
  });

  it('falls back to the first section rather than rendering nothing', () => {
    // An id belonging to an omitted module cannot be reached by remembering it, and
    // an unknown id must not blank the worktable.
    const composed = composeSections(CORE, []);
    expect(currentSection(composed, 'branding')?.id).toBe('structure');
  });

  it('returns null only when there is no section at all', () => {
    expect(currentSection([], 'structure')).toBeNull();
  });
});

describe('isContributed', () => {
  it('separates a self-rendering contribution from a core tab', () => {
    // Core renders from the frame's own state; a contribution cannot reach it and
    // therefore carries its own panel. The distinction decides which path renders.
    expect(isContributed(contribution())).toBe(true);
    const core = CORE[0];
    expect(core === undefined ? null : isContributed(core)).toBe(false);
  });
});
