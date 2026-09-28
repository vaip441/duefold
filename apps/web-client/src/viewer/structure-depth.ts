import type { ViewerEntry } from '../api/client.ts';

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
