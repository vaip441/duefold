import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  loadPreviewDocument,
  loadPreviewRoom,
  loadPreviewTextLayer,
  previewPageImageUrl,
} from './client.ts';

const ROOM = 'r'.repeat(32);
const DOCUMENT = 'd'.repeat(32);
const paths: string[] = [];

function respond(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(payload),
    clone: () => respond(status, payload),
  } as unknown as Response;
}

function reply(payload: unknown, status = 200): void {
  vi.stubGlobal('fetch', (path: string) => {
    paths.push(path);
    return Promise.resolve(respond(status, payload));
  });
}

beforeEach(() => {
  paths.length = 0;
  vi.stubGlobal('document', { cookie: '' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('investor preview API', () => {
  it('reads the room title and entries from the member route', async () => {
    reply({ title: 'Series B', state: 'published', entries: [] });
    await expect(loadPreviewRoom(ROOM)).resolves.toEqual({
      title: 'Series B',
      state: 'published',
      entries: [],
    });
    expect(paths).toEqual([`/api/rooms/preview/structure?roomId=${ROOM}`]);
  });

  it('refuses a room payload without a title or with an unknown state', async () => {
    reply({ state: 'published', entries: [] });
    await expect(loadPreviewRoom(ROOM)).rejects.toBeInstanceOf(ApiError);
    reply({ title: 'Series B', state: 'open', entries: [] });
    await expect(loadPreviewRoom(ROOM)).rejects.toBeInstanceOf(ApiError);
  });

  it('reports a refused preview as denied, so the view can say so', async () => {
    reply(
      { error: { code: 'FORBIDDEN', message: 'This action is not available to you.' } },
      403,
    );
    await expect(loadPreviewRoom(ROOM)).rejects.toMatchObject({ failure: 'denied' });
  });

  it('reads document metadata and passes a null document through', async () => {
    reply({ document: null });
    await expect(
      loadPreviewDocument({ roomId: ROOM, documentId: DOCUMENT }),
    ).resolves.toBeNull();
    expect(paths[0]).toBe(`/api/rooms/preview/document?roomId=${ROOM}&documentId=${DOCUMENT}`);
  });

  it('refuses metadata with an unknown download policy', async () => {
    reply({
      document: {
        documentId: DOCUMENT,
        displayTitle: 'Model',
        publishedVersionId: 'v'.repeat(32),
        pageCount: 2,
        downloadPolicy: 'sometimes',
      },
    });
    await expect(
      loadPreviewDocument({ roomId: ROOM, documentId: DOCUMENT }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('addresses page images by room, document, and page', () => {
    expect(previewPageImageUrl({ roomId: ROOM, documentId: DOCUMENT, pageNumber: 3 })).toBe(
      `/api/rooms/preview/page/image?roomId=${ROOM}&documentId=${DOCUMENT}&pageNumber=3`,
    );
  });

  it('parses the text layer from the member route and keeps every run inert', async () => {
    reply({
      versionId: 'v'.repeat(32),
      accessibleLabel: 'Page 1',
      items: [
        { text: 'Revenue', x: 0.1, y: 0.1, width: 0.2, height: 0.05 },
        {
          text: 'Terms',
          x: 0.1,
          y: 0.2,
          width: 0.2,
          height: 0.05,
          link: {
            interstitialPath: '/api/viewer/links/interstitial?target=x',
            normalizedDomain: 'example.com',
          },
        },
      ],
    });
    const layer = await loadPreviewTextLayer({
      roomId: ROOM,
      documentId: DOCUMENT,
      pageNumber: 1,
    });
    expect(layer.items).toEqual([
      { text: 'Revenue', x: 0.1, y: 0.1, width: 0.2, height: 0.05 },
      { text: 'Terms', x: 0.1, y: 0.2, width: 0.2, height: 0.05 },
    ]);
    expect(paths[0]).toBe(
      `/api/rooms/preview/page/text?roomId=${ROOM}&documentId=${DOCUMENT}&pageNumber=1`,
    );
  });
});
