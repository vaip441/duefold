import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadRoomSettings, reviewVisibility } from './room-settings.ts';

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
