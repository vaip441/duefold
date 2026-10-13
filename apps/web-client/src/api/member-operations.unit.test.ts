import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, loadExports, loadProcessingState } from './client.ts';

const paths: string[] = [];

function respond(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(payload),
    clone: () => respond(payload),
  } as unknown as Response;
}

function stub(payload: unknown): void {
  vi.stubGlobal('fetch', (path: string) => {
    paths.push(path);
    return Promise.resolve(respond(payload));
  });
}

const ROOM_ID = 'r'.repeat(32);
/* Server text with microseconds; rebuilding it through a Date would lose them. */
const CREATED_AT = '2026-10-13 09:15:42.123456+00';

beforeEach(() => {
  paths.length = 0;
  vi.stubGlobal('document', { cookie: '' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadProcessingState', () => {
  const CURSOR = { createdAt: CREATED_AT, versionId: 'v'.repeat(32) };

  it('carries the cursor the server issued, and null on the last page', async () => {
    stub({ versions: [], nextCursor: CURSOR });
    await expect(loadProcessingState({ roomId: ROOM_ID })).resolves.toStrictEqual({
      versions: [],
      nextCursor: CURSOR,
    });
    stub({ versions: [] });
    await expect(loadProcessingState({ roomId: ROOM_ID })).resolves.toMatchObject({
      nextCursor: null,
    });
  });

  it('echoes the cursor text unmodified', async () => {
    stub({ versions: [] });
    await loadProcessingState({ roomId: ROOM_ID, after: CURSOR });
    expect(paths.at(-1)).toBe(
      `/api/documents/processing?roomId=${ROOM_ID}` +
        `&afterCreatedAt=${encodeURIComponent(CREATED_AT)}&afterVersionId=${CURSOR.versionId}`,
    );
  });

  it('refuses a malformed cursor rather than resuming from a guess', async () => {
    stub({ versions: [], nextCursor: { createdAt: CREATED_AT } });
    await expect(loadProcessingState({ roomId: ROOM_ID })).rejects.toBeInstanceOf(ApiError);
  });
});

describe('loadExports', () => {
  const CURSOR = { createdAt: CREATED_AT, exportId: 'e'.repeat(32) };

  it('carries the cursor the server issued, and null on the last page', async () => {
    stub({ exports: [], nextCursor: CURSOR });
    await expect(loadExports({ roomId: ROOM_ID })).resolves.toStrictEqual({
      exports: [],
      nextCursor: CURSOR,
    });
    stub({ exports: [] });
    await expect(loadExports({ roomId: ROOM_ID })).resolves.toMatchObject({ nextCursor: null });
  });

  it('echoes the cursor text unmodified', async () => {
    stub({ exports: [] });
    await loadExports({ roomId: ROOM_ID, after: CURSOR });
    expect(paths.at(-1)).toBe(
      `/api/exports?roomId=${ROOM_ID}` +
        `&afterCreatedAt=${encodeURIComponent(CREATED_AT)}&afterExportId=${CURSOR.exportId}`,
    );
  });

  it('refuses a malformed cursor rather than resuming from a guess', async () => {
    stub({ exports: [], nextCursor: { exportId: CURSOR.exportId } });
    await expect(loadExports({ roomId: ROOM_ID })).rejects.toBeInstanceOf(ApiError);
  });
});
