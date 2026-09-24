/**
 * A room's published contents in the worktable, so a viewer lands on the collection
 * rather than on an instruction to look at the index. Folders are finding-aid headings;
 * documents open in the reader.
 */

import type { ViewerEntry } from '../api/client.ts';
import { translate } from '../i18n/translate.ts';

export interface RoomContentsProps {
  readonly entries: readonly ViewerEntry[];
  readonly depthOf: (entry: ViewerEntry) => number;
  readonly onOpenDocument: (documentId: string) => void;
}

export function RoomContents({
  entries,
  depthOf,
  onOpenDocument,
}: RoomContentsProps): React.ReactElement {
  return (
    <nav className="df-contents" aria-label={translate('viewer.contents.label')}>
      <ul className="df-contents__list">
        {entries.map((entry) => (
          <li
            key={entry.entryId}
            className="df-contents__item"
            data-depth={Math.min(depthOf(entry), 4)}
          >
            {entry.resourceKind === 'folder' ? (
              <span className="df-contents__folder">{entry.displayName}</span>
            ) : (
              <button
                type="button"
                className="df-contents__document"
                onClick={() => {
                  onOpenDocument(entry.resourceId);
                }}
              >
                {entry.displayName}
              </button>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
