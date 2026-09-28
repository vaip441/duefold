import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client.ts';
import { memberPreviewPageSource, protectedPageSource } from './page-source.ts';
import { entryDepth } from './structure-depth.ts';

const ROOM = 'r'.repeat(32);
const DOCUMENT = 'd'.repeat(32);
const CACHE = 'c'.repeat(32);
const ACTIVITY = 'a'.repeat(32);
const page = { roomId: ROOM, documentId: DOCUMENT, pageNumber: 1 };
const calls: { path: string; method: string }[] = [];

function respond(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(payload),
    clone: () => respond(status, payload),
  } as unknown as Response;
}

function serve(textStatus = 200): void {
  vi.stubGlobal('fetch', (path: string, init?: RequestInit) => {
    calls.push({ path, method: init?.method ?? 'GET' });
    if (path === '/api/viewer/pages/cache')
      return Promise.resolve(
        respond(201, { cacheId: CACHE, expiresAt: '2026-09-27T00:00:00.000Z' }),
      );
    return Promise.resolve(
      textStatus === 200
        ? respond(200, { versionId: 'v'.repeat(32), accessibleLabel: 'Page 1', items: [] })
        : respond(textStatus, { error: { code: 'FORBIDDEN', message: 'Refused.' } }),
    );
  });
}

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('document', { cookie: '' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('protected page source', () => {
  it('composes a page once when load and prefetch race for it', async () => {
    serve();
    const source = protectedPageSource(ACTIVITY);
    source.prefetch(page);
    const loaded = await source.load(page, new AbortController().signal);
    expect(calls.filter((call) => call.path === '/api/viewer/pages/cache')).toHaveLength(1);
    expect(loaded.imageUrl).toBe(
      `/api/viewer/pages/image?cacheId=${CACHE}&activityId=${ACTIVITY}`,
    );
  });

  it('composes again once a composition has settled, so access is rechecked', async () => {
    serve();
    const source = protectedPageSource(ACTIVITY);
    await source.load(page, new AbortController().signal);
    await source.load(page, new AbortController().signal);
    expect(calls.filter((call) => call.path === '/api/viewer/pages/cache')).toHaveLength(2);
  });
});

describe('member preview page source', () => {
  it('reads the text layer from the member route and composes nothing', async () => {
    serve();
    const loaded = await memberPreviewPageSource.load(page, new AbortController().signal);
    expect(loaded.imageUrl).toBe(
      `/api/rooms/preview/page/image?roomId=${ROOM}&documentId=${DOCUMENT}&pageNumber=1`,
    );
    memberPreviewPageSource.prefetch({ ...page, pageNumber: 2 });
    expect(calls.map((call) => call.path)).toEqual([
      `/api/rooms/preview/page/text?roomId=${ROOM}&documentId=${DOCUMENT}&pageNumber=1`,
    ]);
  });

  it('fails the page as denied when the manager lost the room', async () => {
    serve(403);
    const failure = await memberPreviewPageSource
      .load(page, new AbortController().signal)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ failure: 'denied' });
  });
});

describe('entry depth', () => {
  it('indents by the disclosed parent chain and roots an orphan at zero', () => {
    const entry = (resourceId: string, parentFolderId: string | null) => ({
      entryId: resourceId,
      resourceKind: 'folder' as const,
      resourceId,
      parentFolderId,
      displayName: resourceId,
      description: '',
      publishedVersionId: null,
      siblingPosition: 1,
    });
    const entries = [entry('a', null), entry('b', 'a'), entry('c', 'b'), entry('d', 'missing')];
    expect(entries.map(entryDepth(entries))).toEqual([0, 1, 2, 0]);
  });
});
