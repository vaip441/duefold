import type { ViewerEntry } from '../api/client.ts';
import type { CollectionEntry } from '../components/AppShell.tsx';

/**
 * Finding-aid indent from the parent chain the server disclosed. An entry whose parent
 * is not in the response is a grant root and sits at depth 0.
 */
export function entryDepth(entries: readonly ViewerEntry[]): (entry: ViewerEntry) => number {
  const byResource = new Map(entries.map((item) => [item.resourceId, item]));
  return (entry) => {
    let depth = 0;
    let parent = entry.parentFolderId;
    while (parent !== null) {
      const next = byResource.get(parent);
      if (next === undefined) break;
      depth += 1;
      parent = next.parentFolderId;
    }
    return depth;
  };
}

/** The published tree as the frame's index: folders are headings, documents open. */
export function collectionEntries(
  entries: readonly ViewerEntry[],
  depthOf: (entry: ViewerEntry) => number,
): readonly CollectionEntry[] {
  return entries.map((entry) => ({
    id: entry.entryId,
    title: entry.displayName,
    depth: depthOf(entry),
    kind: entry.resourceKind === 'folder' ? 'group' : 'item',
  }));
}

interface TreeEntry {
  readonly resourceId: string;
  readonly parentFolderId: string | null;
}

/**
 * Entries in reading order, each folder's children right after it, so an indent always
 * sits under its own parent. The structure readers order by level or by a room-wide key,
 * not by tree. Siblings keep the server's order, which is their position, and an entry
 * whose parent is not in the response is a root, as in `entryDepth`.
 */
export function depthFirst<T extends TreeEntry>(entries: readonly T[]): readonly T[] {
  const present = new Set(entries.map((entry) => entry.resourceId));
  const children = new Map<string | null, T[]>();
  for (const entry of entries) {
    const parent =
      entry.parentFolderId !== null && present.has(entry.parentFolderId)
        ? entry.parentFolderId
        : null;
    const siblings = children.get(parent);
    if (siblings === undefined) children.set(parent, [entry]);
    else siblings.push(entry);
  }
  const ordered: T[] = [];
  const visit = (parent: string | null): void => {
    for (const entry of children.get(parent) ?? []) {
      ordered.push(entry);
      visit(entry.resourceId);
    }
  };
  visit(null);
  return ordered;
}

export interface PathOption<T> {
  readonly entry: T;
  readonly label: string;
}

/**
 * Entries in reading order, each labelled with its path from the room root, so a picker tells
 * "2023 / Contracts" from "2024 / Contracts". `depthFirst` places every parent before its
 * children, so each parent's path is known when its child is reached.
 */
export function pathOptions<T extends TreeEntry & { readonly displayName: string }>(
  entries: readonly T[],
): readonly PathOption<T>[] {
  const paths = new Map<string, string>();
  return depthFirst(entries).map((entry) => {
    const parent = entry.parentFolderId === null ? undefined : paths.get(entry.parentFolderId);
    const label = parent === undefined ? entry.displayName : `${parent} / ${entry.displayName}`;
    paths.set(entry.resourceId, label);
    return { entry, label };
  });
}
