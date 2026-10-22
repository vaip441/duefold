import { describe, expect, it } from 'vitest';
import type { ViewerEntry } from '../api/client.ts';
import { collectionEntries, depthFirst, entryDepth, pathOptions } from './structure-depth.ts';

const entry = (resourceId: string, parentFolderId: string | null = null) => ({
  resourceId,
  parentFolderId,
});
const ids = (entries: readonly { readonly resourceId: string }[]): readonly string[] =>
  entries.map((item) => item.resourceId);

describe('depth-first order', () => {
  // Root folders A and B each hold a child; a document moved into the empty folder C keeps
  // the small order key it was given, so a room-wide order puts it before every folder.
  const reading = ['A', 'a1', 'B', 'b1', 'C', 'moved'];

  it('puts children right after their own folder when the server orders level by level', () => {
    const levels = [
      entry('A'),
      entry('B'),
      entry('C'),
      entry('a1', 'A'),
      entry('b1', 'B'),
      entry('moved', 'C'),
    ];
    expect(ids(depthFirst(levels))).toEqual(reading);
  });

  it('puts a moved document under its folder when the server orders room-wide', () => {
    const roomWide = [
      entry('moved', 'C'),
      entry('A'),
      entry('a1', 'A'),
      entry('B'),
      entry('b1', 'B'),
      entry('C'),
    ];
    expect(ids(depthFirst(roomWide))).toEqual(reading);
  });

  it('keeps sibling order and roots an entry whose parent was not disclosed', () => {
    expect(
      ids(
        depthFirst([
          entry('x2', 'X'),
          entry('orphan', 'missing'),
          entry('X'),
          entry('x1', 'X'),
        ]),
      ),
    ).toEqual(['orphan', 'X', 'x2', 'x1']);
  });
});

describe('path options', () => {
  const named = (resourceId: string, parentFolderId: string | null, displayName: string) => ({
    ...entry(resourceId, parentFolderId),
    displayName,
  });

  it('tells same-named folders apart by their path, in reading order', () => {
    const options = pathOptions([
      named('y2023', null, '2023'),
      named('y2024', null, '2024'),
      named('c2024', 'y2024', 'Contracts'),
      named('c2023', 'y2023', 'Contracts'),
      named('signed', 'c2024', 'Signed'),
    ]);
    expect(options.map(({ entry: { resourceId }, label }) => [resourceId, label])).toEqual([
      ['y2023', '2023'],
      ['c2023', '2023 / Contracts'],
      ['y2024', '2024'],
      ['c2024', '2024 / Contracts'],
      ['signed', '2024 / Contracts / Signed'],
    ]);
  });
});

describe('collection entries', () => {
  it('lists folders as headings and documents as items at their disclosed depth', () => {
    const shared = { description: '', publishedVersionId: null, siblingPosition: 0 };
    const tree: readonly ViewerEntry[] = [
      {
        ...shared,
        entryId: 'e0',
        resourceKind: 'folder',
        resourceId: 'F',
        parentFolderId: null,
        displayName: 'Financials',
      },
      {
        ...shared,
        entryId: 'e1',
        resourceKind: 'document',
        resourceId: 'D',
        parentFolderId: 'F',
        displayName: 'Model',
      },
    ];
    expect(collectionEntries(tree, entryDepth(tree))).toEqual([
      { id: 'e0', title: 'Financials', depth: 0, kind: 'group' },
      { id: 'e1', title: 'Model', depth: 1, kind: 'item' },
    ]);
  });
});
