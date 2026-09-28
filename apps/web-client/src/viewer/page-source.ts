/**
 * Where the page reader gets a page from.
 *
 * The viewer's pages are watermarked per session: a cache object must exist before
 * the image is requested, because delivery requires both a cache id and the preview
 * activity id. The investor preview reads stored derivatives through member routes
 * and has neither. The reader renders both through this one contract.
 */

import {
  createProtectedPage,
  loadPreviewTextLayer,
  loadTextLayer,
  previewPageImageUrl,
  protectedPageImageUrl,
  type TextLayer,
} from '../api/client.ts';

export interface PageAddress {
  readonly roomId: string;
  readonly documentId: string;
  readonly pageNumber: number;
}

export interface LoadedPage {
  readonly imageUrl: string;
  readonly layer: TextLayer;
}

export interface PageSource {
  load(page: PageAddress, signal: AbortSignal): Promise<LoadedPage>;
  /** Best effort; a failure surfaces when the reader arrives at that page. */
  prefetch(page: PageAddress): void;
}

type ProtectedPage = Awaited<ReturnType<typeof createProtectedPage>>;

export function protectedPageSource(activityId: string): PageSource {
  /*
   * Composing a watermarked page is the slow step, so the next page is composed while
   * the current one is read. Composition records nothing: evidence is written only
   * when the image is delivered. An in-flight composition is shared with a reader who
   * arrives at that page before it finishes, and a settled one is dropped so the next
   * request goes back to the server, which reuses the composed page and rechecks access.
   */
  const composing = new Map<string, Promise<ProtectedPage>>();
  const compose = (page: PageAddress): Promise<ProtectedPage> => {
    const key = `${page.roomId}/${page.documentId}/${String(page.pageNumber)}`;
    const inFlight = composing.get(key);
    if (inFlight !== undefined) return inFlight;
    const request = createProtectedPage(page).finally(() => {
      composing.delete(key);
    });
    composing.set(key, request);
    return request;
  };
  return {
    async load(page, signal) {
      const [composed, layer] = await Promise.all([compose(page), loadTextLayer(page, signal)]);
      return {
        imageUrl: protectedPageImageUrl({ cacheId: composed.cacheId, activityId }),
        layer,
      };
    },
    prefetch(page) {
      void compose(page).catch(() => undefined);
    },
  };
}

/* Stored derivatives need no composition, so there is nothing worth reading ahead. */
export const memberPreviewPageSource: PageSource = {
  async load(page, signal) {
    const layer = await loadPreviewTextLayer(page, signal);
    return { imageUrl: previewPageImageUrl(page), layer };
  },
  prefetch: () => undefined,
};
