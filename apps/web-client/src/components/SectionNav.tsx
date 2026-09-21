/**
 * The section tab strip.
 *
 * Links-as-buttons in a `nav`, not an ARIA tablist: a tablist promises arrow-key
 * semantics that add nothing here, and `aria-current` already states which section
 * is showing. The current entry carries the accent rule AND `aria-current`, so the
 * state is never colour alone.
 *
 * Deliberately unanimated. A member moves between sections tens of times in a
 * sitting, which is the frequency at which motion reads as latency rather than as
 * explanation.
 */

import type { SectionTab } from '../contract.ts';

export interface SectionNavProps {
  readonly label: string;
  readonly sections: readonly SectionTab[];
  readonly currentId: string;
  readonly onSelect: (id: string) => void;
}

export function SectionNav({
  label,
  sections,
  currentId,
  onSelect,
}: SectionNavProps): React.ReactElement | null {
  /* One section is not navigation. A strip of one tab is decoration that still
     costs a tab stop. */
  if (sections.length < 2) return null;
  return (
    <nav className="df-sections" aria-label={label}>
      {sections.map((section) => (
        <button
          key={section.id}
          type="button"
          className="df-sections__entry"
          aria-current={section.id === currentId ? 'true' : undefined}
          onClick={() => {
            onSelect(section.id);
          }}
        >
          {section.label()}
        </button>
      ))}
    </nav>
  );
}
