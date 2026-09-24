/**
 * The persistent member frame.
 *
 * Structure is the accessibility contract, and it is settled here so later
 * surfaces inherit it rather than each re-deriving it:
 *   - `banner` holds the room-facts line and the primary action;
 *   - `navigation` holds the collection index;
 *   - `main` holds the worktable and owns the single `h1` for the view;
 *   - `complementary` holds the access-notes margin;
 *   - one polite live region reports asynchronous status.
 *
 * The index and the worktable are related programmatically: index entries carry
 * `aria-controls` pointing at the worktable region, and the current entry carries
 * `aria-current`, so the relationship is not merely visual.
 *
 * This is a LAYOUT. It renders honest empty states from the props it is given and
 * invents no content: nothing here is a placeholder a later surface must remove.
 */

import { useId, useState, type ReactNode } from 'react';
import { translate } from '../i18n/translate.ts';
import { AccountMenu } from './AccountMenu.tsx';
import { BrandLogo } from './BrandLogo.tsx';
import { StatusRegion } from './StatusRegion.tsx';

export interface CollectionEntry {
  readonly id: string;
  /** Display title. Never an internal filename, path, or object key. */
  readonly title: string;
  /** Nesting depth, 0-based, for the finding-aid indent. */
  readonly depth: number;
  /** Folder entries organize the index but do not activate the worktable. */
  readonly kind?: 'item' | 'group';
}

export interface CollectionEmptyState {
  readonly lead: string;
  readonly help: string;
}

export interface AppShellProps {
  /** Worktable heading; exactly one h1 per view. */
  readonly title: string;
  readonly entries: readonly CollectionEntry[];
  readonly currentEntryId: string | null;
  readonly onSelectEntry: (id: string) => void;
  /** Required because each surface owns the meaning of an empty collection.
   * Null leaves the rail silent when the worktable already explains emptiness. */
  readonly indexEmpty: CollectionEmptyState | null;
  /** The room-facts primary action, when the current surface has one. */
  readonly primaryAction?: ReactNode;
  /** Task navigation that remains visible beside the compact account menu. */
  readonly contextActions?: ReactNode;
  readonly accountActions?: ReactNode;
  /** Plain-language effective policy for the current selection. Omitted when the view
   * has nothing to note, and the margin is not drawn at all. */
  readonly notes?: ReactNode;
  readonly status: string;
  readonly children?: ReactNode;
}

const WORKTABLE_ID = 'df-worktable';

export function AppShell({
  title,
  entries,
  currentEntryId,
  onSelectEntry,
  indexEmpty,
  primaryAction,
  contextActions,
  accountActions,
  notes,
  status,
  children,
}: AppShellProps): React.ReactElement {
  const indexHeadingId = useId();
  const notesHeadingId = useId();
  const treeId = useId();
  // The index is a disclosure only in the one-column layout; it stays expanded
  // by default so a keyboard user never has to open it to reach the collection.
  const [indexOpen, setIndexOpen] = useState(true);

  return (
    <div className="df-shell" data-notes={notes === undefined ? 'false' : 'true'}>
      <a className="df-skip" href={`#${WORKTABLE_ID}`}>
        {translate('app.skipToContent')}
      </a>

      <header className="df-facts" aria-label={translate('shell.landmark.roomFacts')}>
        <span className="df-facts__identity">
          <BrandLogo />
        </span>
        <span className="df-facts__actions">
          {primaryAction}
          {contextActions}
          {accountActions === undefined ? null : <AccountMenu>{accountActions}</AccountMenu>}
        </span>
      </header>

      <nav
        className="df-index"
        aria-labelledby={indexHeadingId}
        data-collapsed={indexOpen ? 'false' : 'true'}
      >
        <h2 className="df-index__heading" id={indexHeadingId}>
          {translate('shell.index.heading')}
        </h2>
        <div className="df-index__disclosure">
          <button
            type="button"
            className="df-button df-button--quiet"
            aria-expanded={indexOpen}
            aria-controls={treeId}
            onClick={() => {
              setIndexOpen((open) => !open);
            }}
          >
            {translate('shell.index.toggle')}
          </button>
        </div>
        {/* The disclosure always controls this element, so `aria-controls`
            resolves whether or not the collection has entries. */}
        <div id={treeId} className="df-index__panel">
          {entries.length === 0 ? (
            indexEmpty === null ? null : (
              <div className="df-empty df-index__empty">
                <span className="df-empty__lead">{indexEmpty.lead}</span>
                {indexEmpty.help}
              </div>
            )
          ) : (
            <ul className="df-index__tree">
              {entries.map((entry) => (
                <li key={entry.id}>
                  {entry.kind === 'group' ? (
                    <span
                      className="df-index__entry df-index__entry--group"
                      style={{
                        paddingInlineStart: `calc(var(--space-5) + ${entry.depth} * var(--space-4))`,
                      }}
                    >
                      {entry.title}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="df-index__entry"
                      style={{
                        paddingInlineStart: `calc(var(--space-5) + ${entry.depth} * var(--space-4))`,
                      }}
                      aria-current={entry.id === currentEntryId ? 'true' : undefined}
                      aria-controls={WORKTABLE_ID}
                      onClick={() => {
                        onSelectEntry(entry.id);
                      }}
                    >
                      {entry.title}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </nav>

      <main className="df-worktable" id={WORKTABLE_ID} tabIndex={-1}>
        <h1 className="df-worktable__title">{title}</h1>
        {children ?? (
          <div className="df-empty df-empty--worktable">
            <span className="df-empty__lead">{translate('shell.worktable.empty')}</span>
            {translate('shell.worktable.emptyHelp')}
          </div>
        )}
      </main>

      {notes === undefined ? null : (
        <aside className="df-notes" aria-labelledby={notesHeadingId}>
          <h2 className="df-notes__heading" id={notesHeadingId}>
            {translate('shell.notes.heading')}
          </h2>
          <div className="df-notes__body">{notes}</div>
        </aside>
      )}

      <StatusRegion message={status} label={translate('shell.status.region')} />
    </div>
  );
}
