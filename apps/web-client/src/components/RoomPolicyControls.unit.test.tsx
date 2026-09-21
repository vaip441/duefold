/**
 * Room policy controls unit tests.
 *
 * Verifies download policy selection, exception counts, and default grant expiry display
 * across different server-provided settings.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RoomCapabilities, RoomSettings } from '../api/client.ts';
import { messages } from '../i18n/en.ts';
import type { RoomSettingsSection } from '../workspace/useRoomSettings.ts';
import { RoomPolicyControls } from './RoomPolicyControls.tsx';

const NO_CAPABILITIES: RoomCapabilities = {
  publish: false,
  archive: false,
  returnToDraft: false,
  setRetention: false,
  schedulePurge: false,
  cancelPurge: false,
};

function settingsFor(overrides: Partial<RoomSettings> = {}): RoomSettings {
  return {
    roomId: 'r'.repeat(32),
    state: 'published',
    revision: 5,
    publishedRevision: 2,
    auditRetentionYears: 7,
    defaultGrantExpiresAt: null,
    downloadPolicy: null,
    installationDownloadPolicy: 'deny',
    purge: null,
    capabilities: NO_CAPABILITIES,
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

const render = (settings: RoomSettings, overrideCount = 0) =>
  renderToStaticMarkup(
    <RoomPolicyControls
      settings={settings}
      overrideCount={overrideCount}
      section={mockSection}
      onStatus={() => undefined}
    />,
  );

describe('RoomPolicyControls', () => {
  it('renders download options and states the installation default in words', () => {
    const html = render(
      settingsFor({ downloadPolicy: null, installationDownloadPolicy: 'deny' }),
    );
    expect(html).toContain(messages['settings.download.heading']);
    expect(html).toContain('Use the installation default (denied)');
    expect(html).toContain(messages['settings.download.allow']);
    expect(html).toContain(messages['settings.download.deny']);
  });

  it('reports the count of documents with their own download policy', () => {
    const html = render(settingsFor(), 3);
    expect(html).toContain('Documents with their own download policy: 3.');
  });

  it('states that new grants do not expire when default expiry is null', () => {
    const html = render(settingsFor({ defaultGrantExpiresAt: null }));
    expect(html).toContain(messages['settings.expiry.none']);
  });

  it('states the current default expiry with both localized date and UTC value', () => {
    const html = render(
      settingsFor({ defaultGrantExpiresAt: '2027-09-21T23:59:59.999+00:00' }),
    );
    expect(html).toContain('2027-09-21 23:59:59 UTC');
  });

  it('offers a labelled date field whose review is withheld until a date is chosen', () => {
    const html = render(settingsFor());
    expect(html).toContain(messages['settings.expiry.label']);
    /* The control itself, not only its copy: a missing input would still pass a text check. */
    expect(html).toMatch(/<input[^>]+type="date"/u);
    expect(html).toContain(messages['settings.expiry.review']);
    /* Nothing chosen yet is not a mistake, so no error is shown. */
    expect(html).not.toContain(messages['settings.expiry.invalid']);
  });

  /* The field is bound to the label by id, which is what lets a screen reader announce the
     two together and what `aria-describedby` hangs the help text from. */
  it('binds the date field to its label and its help text', () => {
    const html = render(settingsFor());
    const field = /<input[^>]+id="([^"]+)"[^>]+type="date"/u.exec(html)?.[1];
    expect(field).toBeDefined();
    expect(html).toContain(`for="${field ?? ''}"`);
    expect(html).toContain(`aria-describedby="${field ?? ''}-help"`);
  });
});
