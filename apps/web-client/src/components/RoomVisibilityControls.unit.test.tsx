/**
 * WHICH VISIBILITY CHANGES ARE OFFERED, AND ON WHAT AUTHORITY.
 *
 * These are the most consequential controls in a room: publishing exposes content to
 * viewers and archiving withdraws it. What makes that safe is that the surface offers a
 * control ONLY where the server said the call would be accepted, so the cases below drive
 * the capability object rather than a role name — a rendered control the server then
 * refuses, or a withheld one it would have accepted, are both defects.
 *
 * Rendered to static markup, because what is under test is what the surface offers for a
 * given server answer, not the dialog's interaction (`ConfirmationDialog.unit.test.tsx`
 * owns that).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { messages } from '../i18n/en.ts';
import type { RoomCapabilities, RoomSettings } from '../api/client.ts';
import type { RoomSettingsSection } from '../workspace/useRoomSettings.ts';
import { RoomVisibilityControls } from './RoomVisibilityControls.tsx';

const NO_CAPABILITIES: RoomCapabilities = {
  publish: false,
  archive: false,
  returnToDraft: false,
  setRetention: false,
  schedulePurge: false,
  cancelPurge: false,
};

function settingsFor(
  state: RoomSettings['state'],
  capabilities: Partial<RoomCapabilities>,
  overrides: Partial<RoomSettings> = {},
): RoomSettings {
  return {
    roomId: 'r'.repeat(32),
    state,
    revision: 4,
    publishedRevision: state === 'draft' ? 0 : 2,
    auditRetentionYears: 7,
    defaultGrantExpiresAt: null,
    downloadPolicy: null,
    installationDownloadPolicy: 'deny',
    purge: null,
    capabilities: { ...NO_CAPABILITIES, ...capabilities },
    ...overrides,
  };
}

const section: RoomSettingsSection = {
  load: { kind: 'loading' },
  failure: null,
  reload: () => undefined,
  reviewVisibility: () => Promise.reject(new Error('not called in these cases')),
  applyVisibility: () => Promise.resolve(null),
  setRoomDownloadPolicy: () => Promise.resolve(null),
  reviewDefaultExpiry: () => Promise.reject(new Error('not called in these cases')),
  applyDefaultExpiry: () => Promise.resolve(null),
  reviewRetention: () => Promise.reject(new Error('not called in these cases')),
  applyRetention: () => Promise.resolve(null),
  reviewPurge: () => Promise.reject(new Error('not called in these cases')),
  schedulePurge: () => Promise.resolve(null),
  cancelPurge: () => Promise.resolve(null),
  structureDownloads: () => null,
};

const render = (settings: RoomSettings) =>
  renderToStaticMarkup(
    <RoomVisibilityControls settings={settings} section={section} onStatus={() => undefined} />,
  );

describe('RoomVisibilityControls', () => {
  it('names the current state in words and explains it', () => {
    const html = render(settingsFor('draft', {}));
    expect(html).toContain(messages['rooms.state.draft']);
    /* Named and explained, never carried by colour alone (§21). */
    expect(html).toContain(messages['rooms.state.draft.explain']);
  });

  it('offers nothing to someone the server granted no capability', () => {
    const html = render(settingsFor('published', {}));
    for (const action of [
      'settings.visibility.publish',
      'settings.visibility.archive',
      'settings.visibility.returnToDraft',
    ] as const)
      expect(html).not.toContain(messages[action]);
  });

  it('offers exactly the changes whose capability is true', () => {
    const html = render(settingsFor('draft', { publish: true, archive: true }));
    expect(html).toContain(messages['settings.visibility.publish']);
    expect(html).toContain(messages['settings.visibility.archive']);
    /* Withheld, because a published room is what returning to draft undoes. */
    expect(html).not.toContain(messages['settings.visibility.returnToDraft']);
  });

  it('withholds publication from a draft whose structure was never published', () => {
    /* `publish` false is the server's answer for `published_revision = 0`; the surface must
       not reconstruct that rule, only honour it. */
    const html = render(settingsFor('draft', { archive: true }));
    expect(html).not.toContain(messages['settings.visibility.publish']);
    expect(html).toContain(messages['settings.visibility.archive']);
  });

  it('offers the kill switch alone on an archived room', () => {
    const html = render(settingsFor('archived', { returnToDraft: true }));
    expect(html).toContain(messages['settings.visibility.returnToDraft']);
    expect(html).not.toContain(messages['settings.visibility.publish']);
  });

  it('says why an archived room is held when a purge pins it', () => {
    /* `returnToDraft` is false AND the reason is stated: a control that simply vanishes
       leaves the Owner with no idea that cancelling the purge is the way back. */
    const html = render(
      settingsFor(
        'archived',
        {},
        {
          purge: {
            purgeId: 'p'.repeat(32),
            state: 'scheduled',
            purgeAfter: '2027-01-01T00:00:00.000Z',
          },
        },
      ),
    );
    expect(html).not.toContain(messages['settings.visibility.returnToDraft']);
    expect(html).toContain(messages['settings.visibility.pinnedByPurge']);
  });
});
