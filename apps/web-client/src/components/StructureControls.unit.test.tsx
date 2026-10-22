import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorkingEntry } from '../api/client.ts';
import { destinationOptions, MoveForm } from './StructureControls.tsx';

const folder = (
  id: string,
  parent: string | null,
  displayName: string,
  stagedRemoved = false,
): WorkingEntry =>
  ({
    entryId: `${id}-entry`,
    resourceId: id,
    parentFolderId: parent,
    displayName,
    stagedRemoved,
    resourceKind: 'folder',
  }) as WorkingEntry;

const folders = [
  folder('y2023', null, '2023'),
  folder('y2024', null, '2024'),
  folder('c2023', 'y2023', 'Contracts'),
  folder('c2024', 'y2024', 'Contracts'),
  folder('signed', 'c2024', 'Signed'),
  folder('old', null, 'Old', true),
  folder('inside-old', 'old', 'Drafts'),
];

describe('destinationOptions', () => {
  const ids = (moving: WorkingEntry | null): readonly string[] =>
    destinationOptions(folders, moving).map(({ entry }) => entry.resourceId);

  it('never offers a folder staged for removal or one inside it', () => {
    expect(ids(null)).toEqual(['y2023', 'c2023', 'y2024', 'c2024', 'signed']);
  });

  it('never offers the moved folder or its own subtree', () => {
    expect(ids(folders[3] ?? null)).toEqual(['y2023', 'c2023', 'y2024']);
  });
});

describe('MoveForm', () => {
  const render = (parent: string): string =>
    renderToStaticMarkup(
      <MoveForm
        entry={{ ...folder('report', parent, 'Report'), position: 1 }}
        folders={folders}
        pending={false}
        onMove={() => undefined}
        onCancel={() => undefined}
      />,
    );

  it('starts at the entry’s own folder, named by its path', () => {
    expect(render('c2024')).toMatch(/<option value="c2024" selected="">2024 \/ Contracts</u);
  });

  it('starts at the top level when the entry’s folder is not offered, so it shows what it sends', () => {
    expect(render('old')).toMatch(/<option value="" selected=""/u);
  });
});
