/**
 * Room lifecycle controls unit tests.
 *
 * Drives the server-provided capability object and room state to assert that retention
 * and purge controls appear when their capability is true and are withheld when false,
 * and that reasons are stated in words when controls are withheld.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RoomCapabilities, RoomSettings } from '../api/client.ts';
import { messages } from '../i18n/en.ts';
import type { RoomSettingsSection } from '../workspace/useRoomSettings.ts';
import { RoomLifecycleControls } from './RoomLifecycleControls.tsx';

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
    revision: 5,
    publishedRevision: 1,
    auditRetentionYears: 7,
    defaultGrantExpiresAt: null,
    downloadPolicy: null,
    installationDownloadPolicy: 'deny',
    purge: null,
    capabilities: { ...NO_CAPABILITIES, ...capabilities },
    ...overrides,
  };
}

const mockSection: RoomSettingsSection = {
  load: { kind: 'loading' },
  failure: null,
  reload: () => undefined,
  reviewVisibility: () => Promise.reject(new Error('not called')),
  applyVisibility: () => Promise.resolve(null),
  setRoomDownloadPolicy: () => Promise.resolve(null),
  reviewDefaultExpiry: () => Promise.reject(new Error('not called')),
  applyDefaultExpiry: () => Promise.resolve(null),
  reviewRetention: () => Promise.reject(new Error('not called')),
  applyRetention: () => Promise.resolve(null),
  reviewPurge: () => Promise.reject(new Error('not called')),
  schedulePurge: () => Promise.resolve(null),
  cancelPurge: () => Promise.resolve(null),
  structureDownloads: () => null,
};

const render = (settings: RoomSettings) =>
  renderToStaticMarkup(
    <RoomLifecycleControls
      settings={settings}
      section={mockSection}
      onStatus={() => undefined}
    />,
  );

describe('RoomLifecycleControls retention', () => {
  it('offers the retention select and review button when setRetention is true', () => {
    const html = render(settingsFor('draft', { setRetention: true }));
    expect(html).toContain(messages['settings.retention.heading']);
    expect(html).toContain('<select');
    expect(html).toContain(messages['settings.retention.review']);
  });

  it('explains that only the Owner can change retention when setRetention is false in draft', () => {
    const html = render(settingsFor('draft', { setRetention: false }));
    expect(html).not.toContain('<select');
    expect(html).not.toContain(messages['settings.retention.review']);
    expect(html).toContain(messages['settings.retention.ownerOnly']);
  });

  it('explains that retention is locked when setRetention is false and room is published', () => {
    const html = render(settingsFor('published', { setRetention: false }));
    expect(html).not.toContain('<select');
    expect(html).toContain(messages['settings.retention.locked']);
  });
});

describe('RoomLifecycleControls purge', () => {
  it('does not render the purge section for a draft room with no purge', () => {
    const html = render(settingsFor('draft', {}));
    expect(html).not.toContain(messages['settings.purge.heading']);
  });

  it('renders purge section and schedule button when room is archived and schedulePurge is true', () => {
    const html = render(settingsFor('archived', { schedulePurge: true }));
    expect(html).toContain(messages['settings.purge.heading']);
    expect(html).toContain(messages['settings.purge.none']);
    expect(html).toContain(messages['settings.purge.schedule']);
  });

  it('withholds the schedule purge button when schedulePurge is false', () => {
    const html = render(settingsFor('archived', { schedulePurge: false }));
    expect(html).toContain(messages['settings.purge.heading']);
    expect(html).not.toContain(messages['settings.purge.schedule']);
  });

  it('shows scheduled status and cancel button when purge is scheduled and cancelPurge is true', () => {
    const html = render(
      settingsFor(
        'archived',
        { cancelPurge: true },
        {
          purge: {
            purgeId: 'p'.repeat(32),
            state: 'scheduled',
            purgeAfter: '2026-10-21T00:00:00.000Z',
          },
        },
      ),
    );
    expect(html).toContain(messages['settings.purge.cancel']);
    expect(html).toContain('2026-10-21 00:00:00 UTC');
  });

  it('withholds cancel button when cancelPurge is false', () => {
    const html = render(
      settingsFor(
        'archived',
        { cancelPurge: false },
        {
          purge: {
            purgeId: 'p'.repeat(32),
            state: 'scheduled',
            purgeAfter: '2026-10-21T00:00:00.000Z',
          },
        },
      ),
    );
    expect(html).not.toContain(messages['settings.purge.cancel']);
  });
});
