/**
 * Investor preview: a Room Manager reads the published room through member routes.
 * The shapes match the viewer's, so the reader components render either unchanged.
 */

import { ApiError, isRecord, json, oneOf, requireArray, requireString } from './transport.ts';
import {
  parseTextLayerPayload,
  parseViewerDocument,
  type TextLayer,
  type ViewerDocument,
  type ViewerEntry,
} from './viewer.ts';

export type PreviewRoomState = 'draft' | 'published' | 'archived';

export interface PreviewRoom {
  readonly title: string;
  /** Investors reach a room only while it is published. */
  readonly state: PreviewRoomState;
  readonly entries: readonly ViewerEntry[];
}

interface PageAddress {
  readonly roomId: string;
  readonly documentId: string;
  readonly pageNumber: number;
}

function pageQuery(input: PageAddress): string {
  return `roomId=${encodeURIComponent(input.roomId)}&documentId=${encodeURIComponent(input.documentId)}&pageNumber=${String(input.pageNumber)}`;
}

export async function loadPreviewRoom(
  roomId: string,
  signal?: AbortSignal,
): Promise<PreviewRoom> {
  const payload = await json({
    method: 'GET',
    path: `/api/rooms/preview/structure?roomId=${encodeURIComponent(roomId)}`,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  return {
    title: requireString(payload, 'title'),
    state: oneOf<PreviewRoomState>(['draft', 'published', 'archived'], payload['state']),
    entries: requireArray(payload, 'entries') as readonly ViewerEntry[],
  };
}

export async function loadPreviewDocument(
  input: { readonly roomId: string; readonly documentId: string },
  signal?: AbortSignal,
): Promise<ViewerDocument | null> {
  const payload = await json({
    method: 'GET',
    path: `/api/rooms/preview/document?roomId=${encodeURIComponent(input.roomId)}&documentId=${encodeURIComponent(input.documentId)}`,
    ...(signal === undefined ? {} : { signal }),
  });
  return parseViewerDocument(payload);
}

export function previewPageImageUrl(input: PageAddress): string {
  return `/api/rooms/preview/page/image?${pageQuery(input)}`;
}

/** Links are inert in preview; any the server sent are dropped rather than rendered. */
export async function loadPreviewTextLayer(
  input: PageAddress,
  signal?: AbortSignal,
): Promise<TextLayer> {
  const payload = await json({
    method: 'GET',
    path: `/api/rooms/preview/page/text?${pageQuery(input)}`,
    ...(signal === undefined ? {} : { signal }),
  });
  const layer = parseTextLayerPayload(payload);
  return {
    ...layer,
    items: layer.items.map(({ text, x, y, width, height }) => ({ text, x, y, width, height })),
  };
}
