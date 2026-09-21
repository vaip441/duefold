import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { InstallationStatus } from '../api/client.ts';
import { messages } from '../i18n/en.ts';
import type { PresentedFailure } from '../workspace/failures.ts';
import type { LoadedSection } from '../workspace/useLoad.ts';
import { StatusPanel } from './StatusPanel.tsx';

const READY: InstallationStatus = {
  deployment: {
    application: {
      version: '1.0.0',
      modules: ['core-security'],
      adapters: { storage: 's3-compatible', mail: 'smtp', identity: 'oidc' },
    },
    oidc: { discoveryConformedAt: '2026-09-21T08:00:00.000Z' },
    migrations: { state: 'current', appliedCount: 1, expectedCount: 1, latestApplied: '001_a' },
    queue: { due: 0, running: 0, failedRecently: 0, oldestDueSeconds: null },
    mail: { lastDeliveredAt: null, failedRecently: 0 },
    checks: [
      {
        check: 'storage-privacy',
        observation: {
          result: 'fail',
          code: 'ANONYMOUS_LIST_ALLOWED',
          evidenceAt: null,
          evidenceVersion: null,
          observedAt: '2026-09-21T09:00:00.000Z',
          stale: false,
        },
      },
      { check: 'storage-versioning', observation: null },
      { check: 'scanner', observation: null },
      { check: 'updates', observation: null },
    ],
  },
  content: {
    processing: { failedCount: 0 },
    recovery: {
      backupStatus: 'undetermined',
      backupRetention: null,
      recoveryExpectation: null,
      acknowledgedAt: null,
      restoreDrillStatus: 'not-tested',
      restoreDrillAt: null,
    },
  },
};

const section = (
  load: LoadedSection<InstallationStatus>['load'],
  failure: PresentedFailure | null = null,
): LoadedSection<InstallationStatus> => ({ load, failure, reload: () => undefined });

describe('StatusPanel', () => {
  it('says it is loading', () => {
    expect(
      renderToStaticMarkup(<StatusPanel section={section({ kind: 'loading' })} />),
    ).toContain(messages['status.loading']);
  });

  it('renders a denial without describing what it withholds', () => {
    const markup = renderToStaticMarkup(
      <StatusPanel
        section={section(
          { kind: 'failed', failure: 'denied' },
          { kind: 'denied', title: null, body: 'denied', offerReload: false },
        )}
      />,
    );
    expect(markup).toContain(messages['status.denied']);
    expect(markup).not.toContain('<table');
  });

  it('renders every check as a labelled row, its state in words, and times as time elements', () => {
    const markup = renderToStaticMarkup(
      <StatusPanel section={section({ kind: 'ready', value: READY })} />,
    );
    expect([...markup.matchAll(/<th scope="row"/gu)]).toHaveLength(12);
    expect(markup).toContain(messages['status.state.fail']);
    expect(markup).toContain(messages['status.state.unchecked']);
    expect(markup).toMatch(/<time datetime="2026-09-21T09:00:00.000Z"/iu);
    expect(markup).toContain(`data-label="${messages['status.column.state']}"`);
    expect(markup).toContain(messages['status.intro']);
  });

  it('leads with how many checks are failing', () => {
    const markup = renderToStaticMarkup(
      <StatusPanel section={section({ kind: 'ready', value: READY })} />,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain(messages['status.summary.failing'].replace('{count}', '1'));
  });
});
