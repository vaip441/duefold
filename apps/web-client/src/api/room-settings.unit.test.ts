import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyDefaultExpiry,
  loadRoomSettings,
  reviewDefaultExpiry,
  reviewPurge,
  reviewVisibility,
} from './room-settings.ts';

const ID = 'r'.repeat(32);
const SETTINGS = {
  roomId: ID,
  state: 'draft',
  revision: 3,
  publishedRevision: 0,
  auditRetentionYears: 7,
  defaultGrantExpiresAt: null,
  downloadPolicy: null,
  installationDownloadPolicy: 'deny',
  purge: null,
  capabilities: {
    publish: false,
    archive: true,
    returnToDraft: false,
    setRetention: true,
    schedulePurge: false,
    cancelPurge: false,
  },
};

function stub(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })),
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadRoomSettings', () => {
  it('parses settings and indexes download overrides by document', async () => {
    stub({
      settings: SETTINGS,
      downloadOverrides: [{ documentId: 'd'.repeat(32), policy: 'allow' }],
    });
    const view = await loadRoomSettings(ID);
    expect(view.settings.capabilities.archive).toBe(true);
    expect(view.downloadOverrides.get('d'.repeat(32))).toBe('allow');
  });

  it.each([
    [{ ...SETTINGS, state: 'live' }],
    [{ ...SETTINGS, capabilities: { ...SETTINGS.capabilities, publish: 'yes' } }],
    [{ ...SETTINGS, downloadPolicy: 'sometimes' }],
    [{ ...SETTINGS, purge: { purgeId: ID, state: 'scheduled' } }],
  ])('fails closed on a value this client does not recognize', async (settings) => {
    stub({ settings, downloadOverrides: [] });
    await expect(loadRoomSettings(ID)).rejects.toMatchObject({ failure: 'unavailable' });
  });
});

describe('reviewVisibility', () => {
  it('parses the impact the server computed', async () => {
    vi.stubGlobal('document', { cookie: '__Host-duefold_csrf=token' });
    stub({
      impact: {
        roomId: ID,
        currentState: 'draft',
        proposedState: 'published',
        viewerCount: 2,
        publishedDocumentCount: 5,
        requiresFreshAuthentication: true,
        expectedRevision: 3,
        confirmation: 'PUBLISH ROOM',
      },
    });
    expect(await reviewVisibility(ID, 'published')).toMatchObject({
      viewerCount: 2,
      confirmation: 'PUBLISH ROOM',
    });
  });
});

describe('reviewDefaultExpiry', () => {
  it('keeps the exact instant new grants will inherit', async () => {
    vi.stubGlobal('document', { cookie: '__Host-duefold_csrf=token' });
    stub({
      impact: {
        affectedCount: 1,
        paths: ['Series A'],
        resolvedExpiresAt: '2027-09-21T23:59:59.999+00:00',
        confirmation: 'CHANGE DEFAULT EXPIRY FOR 1 ROOM',
        message: 'x',
      },
    });
    expect(await reviewDefaultExpiry(ID, '2027-09-21T23:59:59.999Z')).toStrictEqual({
      affectedCount: 1,
      paths: ['Series A'],
      resolvedExpiresAt: '2027-09-21T23:59:59.999+00:00',
      confirmation: 'CHANGE DEFAULT EXPIRY FOR 1 ROOM',
      message: 'x',
    });
  });

  /* A review body is not evidence that anything was applied: the apply answers the room's new
     revision, and accepting one without it would report a change that never happened. */
  it('refuses an apply response that carries no new room revision', async () => {
    vi.stubGlobal('document', { cookie: '__Host-duefold_csrf=token' });
    stub({
      impact: {
        affectedCount: 1,
        paths: ['Series A'],
        resolvedExpiresAt: null,
        confirmation: 'CHANGE DEFAULT EXPIRY FOR 1 ROOM',
        message: 'x',
      },
    });
    await expect(
      applyDefaultExpiry(ID, null, 3, 'CHANGE DEFAULT EXPIRY FOR 1 ROOM'),
    ).rejects.toMatchObject({ failure: 'unavailable' });
  });
});

describe('reviewPurge', () => {
  it('parses what the purge will remove', async () => {
    vi.stubGlobal('document', { cookie: '__Host-duefold_csrf=token' });
    stub({
      purge: {
        roomId: ID,
        documentCount: 12,
        viewerCount: 4,
        sourceBytes: 2_500_000,
        cancellationDays: 30,
        confirmation: 'SCHEDULE ROOM PURGE',
      },
    });
    /* Every field, so dropping one from the parser fails here rather than surfacing as a
       purge consequence missing a number the Owner was meant to weigh. */
    expect(await reviewPurge(ID)).toStrictEqual({
      documentCount: 12,
      viewerCount: 4,
      sourceBytes: 2_500_000,
      cancellationDays: 30,
      confirmation: 'SCHEDULE ROOM PURGE',
    });
  });

  /* A total above 2^53 has already lost precision in JSON, so showing it rounded would put a
     wrong number in front of an irreversible decision. */
  it('refuses a byte total it cannot represent exactly', async () => {
    vi.stubGlobal('document', { cookie: '__Host-duefold_csrf=token' });
    stub({
      purge: {
        roomId: ID,
        documentCount: 1,
        viewerCount: 1,
        sourceBytes: Number.MAX_SAFE_INTEGER + 2,
        cancellationDays: 30,
        confirmation: 'SCHEDULE ROOM PURGE',
      },
    });
    await expect(reviewPurge(ID)).rejects.toMatchObject({ failure: 'unavailable' });
  });

  it('fails closed on a cancellation period this client does not know', async () => {
    vi.stubGlobal('document', { cookie: '__Host-duefold_csrf=token' });
    stub({
      purge: {
        roomId: ID,
        documentCount: 1,
        viewerCount: 0,
        sourceBytes: 1,
        cancellationDays: 7,
        confirmation: 'SCHEDULE ROOM PURGE',
      },
    });
    await expect(reviewPurge(ID)).rejects.toMatchObject({ failure: 'unavailable' });
  });
});
