/**
 * Viewer discovery and protected delivery.
 *
 * Split out of api/client.ts, which had grown to hold every HTTP domain in one
 * file. The transport, CSRF handling, and failure classification stay shared in
 * transport.ts so there is exactly one place that talks to the network.
 */

import {
  ApiError,
  failureForStatus,
  isRecord,
  json,
  requireArray,
  requireNumber,
  requireString,
  serverErrorCode,
} from './transport.ts';

export interface ViewerRoom {
  readonly roomId: string;
  readonly title: string;
  readonly description: string;
}

export interface ViewerEntry {
  readonly entryId: string;
  readonly resourceKind: 'folder' | 'document';
  readonly resourceId: string;
  readonly parentFolderId: string | null;
  readonly displayName: string;
  readonly description: string;
  readonly publishedVersionId: string | null;
  readonly siblingPosition: number;
}

export type DownloadPolicy = 'allow' | 'deny';

export interface ViewerDocument {
  readonly documentId: string;
  readonly displayTitle: string;
  readonly publishedVersionId: string;
  readonly pageCount: number;
  readonly downloadPolicy: DownloadPolicy;
}

/** One search hit inside a room. Carries its path so it can be placed. */
export interface ViewerSearchHit {
  readonly resourceKind: 'folder' | 'document';
  readonly resourceId: string;
  readonly displayName: string;
  readonly description: string;
  readonly path: string;
}

/** One positioned run of sanitized text. Fractions of the page box, 0..1. */
export interface TextLayerItem {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /**
   * Present only for links the SERVER judged safe. A credential-bearing,
   * malformed, non-HTTPS, or unsafe-scheme URL arrives with no `link`, and such
   * an item must render as inert text.
   */
  readonly link?: {
    readonly interstitialPath: string;
    readonly normalizedDomain: string;
  };
}

export interface TextLayer {
  readonly versionId: string;
  /** Used as the page image's accessible name when extraction produced no text. */
  readonly accessibleLabel: string;
  readonly items: readonly TextLayerItem[];
}

export interface PreviewActivity {
  readonly activityId: string;
  readonly correlationId: string;
}

export interface DownloadLease {
  readonly leaseId: string;
  readonly versionId: string;
  readonly sizeBytes: number;
  readonly expiresAt: string;
  readonly filename: string;
  readonly correlationId: string;
}

export interface InterstitialTarget {
  readonly normalizedDomain: string;
  readonly destination: string;
  readonly warning: string;
  readonly rel: string;
}

export async function loadViewerRooms(signal?: AbortSignal): Promise<readonly ViewerRoom[]> {
  const payload = await json({
    method: 'GET',
    path: '/api/viewer/rooms',
    ...(signal === undefined ? {} : { signal }),
  });
  return requireArray(payload, 'rooms') as readonly ViewerRoom[];
}

export async function loadViewerStructure(
  roomId: string,
  signal?: AbortSignal,
): Promise<readonly ViewerEntry[]> {
  const payload = await json({
    method: 'GET',
    path: `/api/viewer/structure?roomId=${encodeURIComponent(roomId)}`,
    ...(signal === undefined ? {} : { signal }),
  });
  return requireArray(payload, 'entries') as readonly ViewerEntry[];
}

/**
 * Searches within one room. The server returns `results`, and each hit carries
 * the path that leads to it so a grant-rooted hit is placeable.
 */
export async function searchViewerRoom(
  roomId: string,
  query: string,
  signal?: AbortSignal,
): Promise<readonly ViewerSearchHit[]> {
  const payload = await json({
    method: 'GET',
    path: `/api/viewer/search?roomId=${encodeURIComponent(roomId)}&query=${encodeURIComponent(query)}`,
    ...(signal === undefined ? {} : { signal }),
  });
  return requireArray(payload, 'results') as readonly ViewerSearchHit[];
}

/**
 * Reads one document's published metadata. Resolves `null` when the server
 * discloses nothing for it, which is indistinguishable from "does not exist".
 */
export async function loadViewerDocument(
  input: { readonly roomId: string; readonly documentId: string },
  signal?: AbortSignal,
): Promise<ViewerDocument | null> {
  const payload = await json({
    method: 'GET',
    path: `/api/viewer/document?roomId=${encodeURIComponent(input.roomId)}&documentId=${encodeURIComponent(input.documentId)}`,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  const document = payload['document'];
  if (document === null) return null;
  if (!isRecord(document)) throw new ApiError('unavailable');
  const policy = document['downloadPolicy'];
  if (policy !== 'allow' && policy !== 'deny') throw new ApiError('unavailable');
  return {
    documentId: requireString(document, 'documentId'),
    displayTitle: requireString(document, 'displayTitle'),
    publishedVersionId: requireString(document, 'publishedVersionId'),
    pageCount: requireNumber(document, 'pageCount'),
    downloadPolicy: policy,
  };
}

export async function beginPreview(
  input: {
    readonly roomId: string;
    readonly documentId: string;
    readonly versionId: string;
  },
  signal?: AbortSignal,
): Promise<PreviewActivity> {
  const payload = await json({
    method: 'POST',
    path: '/api/viewer/previews',
    body: input,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  return {
    activityId: requireString(payload, 'activityId'),
    correlationId: requireString(payload, 'correlationId'),
  };
}

export async function heartbeatPreview(activityId: string): Promise<boolean> {
  const payload = await json({
    method: 'POST',
    path: '/api/viewer/previews/heartbeat',
    body: { activityId },
  });
  if (!isRecord(payload) || typeof payload['accepted'] !== 'boolean')
    throw new ApiError('unavailable');
  return payload['accepted'];
}

export async function closePreview(
  activityId: string,
  status: 'closed' | 'inactive',
): Promise<void> {
  await json({
    method: 'POST',
    path: '/api/viewer/previews/close',
    body: { activityId, status },
  });
}

/**
 * Asks the server to composite a watermarked page and return its cache handle.
 * The bytes are fetched separately, and that delivery re-checks authorization.
 */
export async function createProtectedPage(input: {
  readonly roomId: string;
  readonly documentId: string;
  readonly pageNumber: number;
}): Promise<{ readonly cacheId: string; readonly expiresAt: string }> {
  const payload = await json({
    method: 'POST',
    path: '/api/viewer/pages/cache',
    body: input,
  });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  return {
    cacheId: requireString(payload, 'cacheId'),
    expiresAt: requireString(payload, 'expiresAt'),
  };
}

/**
 * The page image URL. Both identifiers are required by the server contract, so a
 * page cannot be delivered without the preview activity that records it.
 * This returns a URL rather than bytes so the browser can
 * stream the image into an `<img>` element and honour its own cache headers; the
 * response is `no-store`, so nothing is retained.
 */
export function protectedPageImageUrl(input: {
  readonly cacheId: string;
  readonly activityId: string;
}): string {
  return `/api/viewer/pages/image?cacheId=${encodeURIComponent(input.cacheId)}&activityId=${encodeURIComponent(input.activityId)}`;
}

export async function loadTextLayer(
  input: {
    readonly roomId: string;
    readonly documentId: string;
    readonly pageNumber: number;
  },
  signal?: AbortSignal,
): Promise<TextLayer> {
  const payload = await json({
    method: 'GET',
    path: `/api/viewer/pages/text?roomId=${encodeURIComponent(input.roomId)}&documentId=${encodeURIComponent(input.documentId)}&pageNumber=${String(input.pageNumber)}`,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  const rawItems = payload['items'];
  if (!Array.isArray(rawItems)) throw new ApiError('unavailable');
  const items = rawItems.map((entry): TextLayerItem => {
    if (!isRecord(entry)) throw new ApiError('unavailable');
    const base = {
      text: requireString(entry, 'text'),
      x: requireNumber(entry, 'x'),
      y: requireNumber(entry, 'y'),
      width: requireNumber(entry, 'width'),
      height: requireNumber(entry, 'height'),
    };
    const link = entry['link'];
    /*
     * A malformed link is dropped rather than rendered: the item stays as inert
     * text. Presenting a link whose shape the server did not vouch for would
     * defeat the interstitial, which is the only sanctioned way out of a
     * document.
     */
    if (!isRecord(link)) return base;
    const interstitialPath = link['interstitialPath'];
    const normalizedDomain = link['normalizedDomain'];
    if (
      typeof interstitialPath !== 'string' ||
      typeof normalizedDomain !== 'string' ||
      !interstitialPath.startsWith('/api/viewer/links/interstitial?target=') ||
      normalizedDomain === ''
    )
      return base;
    return { ...base, link: { interstitialPath, normalizedDomain } };
  });
  return {
    versionId: requireString(payload, 'versionId'),
    accessibleLabel: requireString(payload, 'accessibleLabel'),
    items,
  };
}

export async function resolveInterstitial(
  interstitialPath: string,
  signal?: AbortSignal,
): Promise<InterstitialTarget> {
  const payload = await json({
    method: 'GET',
    path: interstitialPath,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  return {
    normalizedDomain: requireString(payload, 'normalizedDomain'),
    destination: requireString(payload, 'destination'),
    warning: requireString(payload, 'warning'),
    rel: requireString(payload, 'rel'),
  };
}

export async function createDownloadLease(input: {
  readonly roomId: string;
  readonly documentId: string;
}): Promise<DownloadLease> {
  const payload = await json({
    method: 'POST',
    path: '/api/viewer/downloads',
    body: input,
  });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  return {
    leaseId: requireString(payload, 'leaseId'),
    versionId: requireString(payload, 'versionId'),
    sizeBytes: requireNumber(payload, 'sizeBytes'),
    expiresAt: requireString(payload, 'expiresAt'),
    filename: requireString(payload, 'filename'),
    correlationId: requireString(payload, 'correlationId'),
  };
}

/** One authenticated range request. Every range is re-authorized server-side. */
export async function fetchDownloadRange(input: {
  readonly leaseId: string;
  readonly start: number;
  readonly end: number;
  readonly signal?: AbortSignal;
}): Promise<ArrayBuffer> {
  let response: Response;
  try {
    response = await fetch(
      `/api/viewer/downloads/range?leaseId=${encodeURIComponent(input.leaseId)}`,
      {
        method: 'GET',
        headers: { range: `bytes=${String(input.start)}-${String(input.end)}` },
        credentials: 'same-origin',
        cache: 'no-store',
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    );
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError('offline');
  }
  if (!response.ok)
    throw new ApiError(failureForStatus(response.status, await serverErrorCode(response)));
  return response.arrayBuffer();
}

/*
 * ---------------------------------------------------------------------------
 * Participants, grants, processing, exports, and branding
 *
 * Two rules shape everything below.
 *
 * FIRST: grant impact is never computed here. `affectedCount` and `paths` come
 * from the server's dry-run, and apply echoes the server's `grantId`,
 * `confirmation`, and `expectedRoomRevision`. A client-side estimate of "who can
 * now see what" would be a second definition of access that could disagree with
 * the authoritative one, and a Manager would be deciding on the wrong number.
 *
 * SECOND: an expired grant is reported, not hidden. The reader deliberately
 * returns `effective: false` rather than omitting the row, because a Manager
 * cannot fix an expiry they cannot see.
 * ---------------------------------------------------------------------------
 */
