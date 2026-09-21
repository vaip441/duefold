import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { InstallationSettings } from '../api/client.ts';
import { messages } from '../i18n/en.ts';
import type { PresentedFailure } from '../workspace/failures.ts';
import type { InstallationSettingsSection } from '../workspace/useInstallationSettings.ts';
import { InstallationPanel } from './InstallationPanel.tsx';

const READY: InstallationSettings = {
  downloadPolicy: 'deny',
  revision: 3,
  inheritingRoomCount: 4,
};

const createSection = (
  load: InstallationSettingsSection['load'],
  failure: PresentedFailure | null = null,
): InstallationSettingsSection => ({
  load,
  failure,
  reload: () => undefined,
  reviewDownload: () => Promise.reject(new Error('not called')),
  applyDownload: () => Promise.resolve(null),
});

describe('InstallationPanel', () => {
  it('says it is loading', () => {
    const markup = renderToStaticMarkup(
      <InstallationPanel
        section={createSection({ kind: 'loading' })}
        onStatus={() => undefined}
      />,
    );
    expect(markup).toContain(messages['installation.loading']);
    expect(markup).toContain(messages['installation.heading']);
  });

  it('renders a denial without describing what it withholds', () => {
    const markup = renderToStaticMarkup(
      <InstallationPanel
        section={createSection(
          { kind: 'failed', failure: 'denied' },
          { kind: 'denied', title: null, body: 'denied', offerReload: false },
        )}
        onStatus={() => undefined}
      />,
    );
    expect(markup).toContain(messages['installation.denied']);
    expect(markup).not.toContain(messages['installation.download.heading']);
  });

  it('renders a retry button when failure allows retry', () => {
    const markup = renderToStaticMarkup(
      <InstallationPanel
        section={createSection(
          { kind: 'failed', failure: 'offline' },
          { kind: 'offline', title: 'Offline', body: 'Network down', offerReload: false },
        )}
        onStatus={() => undefined}
      />,
    );
    expect(markup).toContain('Network down');
    expect(markup).toContain(messages['app.retry']);
  });

  it('renders the download controls when ready', () => {
    const markup = renderToStaticMarkup(
      <InstallationPanel
        section={createSection({ kind: 'ready', value: READY })}
        onStatus={() => undefined}
      />,
    );
    expect(markup).toContain(messages['installation.heading']);
    expect(markup).toContain(messages['installation.download.heading']);
    expect(markup).toContain(messages['installation.download.denied']);
    expect(markup).toContain(messages['installation.download.allow']);
  });
});
