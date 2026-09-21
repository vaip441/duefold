/**
 * Section navigation, composed rather than hardcoded.
 *
 * A literal tab array shipped an omitted module's tab and panel in the browser
 * bundle, which contradicts the invariant that an omitted module is absent from
 * production artifacts rather than hidden by a runtime check. Core tabs are
 * declared by the view that renders them; a module's sections arrive through the
 * build-time registry, which names only the composed modules' entries.
 *
 * This is navigation, not authorization. A section being present says only that
 * its module was composed; every request it makes is authorized by the server, and
 * a section whose reader refuses renders its own denied state.
 */

import { composedBrowserEntries } from 'virtual:duefold/browser-entries';
import type { SectionContribution, SectionTab } from '../contract.ts';

export type SectionScope = SectionTab['scope'];

/** The contributed sections for one scope, in the order they will be shown. */
export function contributedSections(scope: SectionScope): readonly SectionContribution[] {
  return composedBrowserEntries
    .flatMap((entry) => entry.contribution.sections ?? [])
    .filter((section) => section.scope === scope);
}

/**
 * Composes the tab strip for one scope.
 *
 * Core tabs take 10, 20, 30, 40; a contribution sorts in by `order`. Ties fall back
 * to `id` so the strip has one stable order rather than depending on registry
 * sequence, which is generation order and not a product decision.
 */
export function composeSections<T extends SectionTab>(
  core: readonly T[],
  contributed: readonly SectionContribution[],
): readonly (T | SectionContribution)[] {
  return [...core, ...contributed].sort((left, right) =>
    left.order === right.order ? left.id.localeCompare(right.id) : left.order - right.order,
  );
}

/**
 * Resolves which tab is current.
 *
 * A requested id is honoured only if the composed strip actually contains it, so a
 * section belonging to an omitted module cannot be reached by remembering its id,
 * and the frame falls back to the first tab rather than rendering nothing.
 */
export function currentSection<T extends SectionTab>(
  sections: readonly T[],
  requestedId: string,
): T | null {
  return sections.find((section) => section.id === requestedId) ?? sections[0] ?? null;
}

/** Whether a resolved tab is a module contribution, and so renders itself. */
export function isContributed(section: SectionTab): section is SectionContribution {
  return 'render' in section;
}
