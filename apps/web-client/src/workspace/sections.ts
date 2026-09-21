/**
 * Section navigation, composed rather than hardcoded.
 *
 * A literal tab array shipped an omitted module's tab and panel in the browser
 * bundle, which contradicts the invariant that an omitted module is absent from
 * production artifacts rather than hidden by a runtime check. Core tabs are
 * declared by the view that renders them; a module's sections arrive through the
 * build-time registry, which names only the composed modules' entries.
 *
 * A section being present says only that its module was composed, not that the member may
 * use it; a section whose reader refuses renders its own denied state.
 */

import { composedBrowserEntries } from 'virtual:duefold/browser-entries';
import type {
  RoomSectionContribution,
  SectionContribution,
  SectionTab,
  TopSectionContribution,
} from '../contract.ts';

export type SectionScope = SectionTab['scope'];

/**
 * The contributed sections for one scope, in the order they will be shown.
 *
 * Overloaded on the scope so the caller receives contributions whose `render` takes
 * that scope's props. A room view therefore gets sections it can call with the room
 * id it has, and the null-room case a single props type used to force on every room
 * section is unrepresentable rather than handled.
 */
export function contributedSections(scope: 'top'): readonly TopSectionContribution[];
export function contributedSections(scope: 'room'): readonly RoomSectionContribution[];
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
export function composeSections<T extends SectionTab, C extends SectionContribution>(
  core: readonly T[],
  contributed: readonly C[],
): readonly (T | C)[] {
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

/**
 * Whether a resolved tab is a module contribution, and so renders itself.
 *
 * Generic in the contribution type, so narrowing a strip composed from room
 * contributions yields a room contribution and the caller may pass its room id.
 */
export function isContributed<C extends SectionContribution>(
  section: SectionTab | C,
): section is C {
  return 'render' in section;
}
