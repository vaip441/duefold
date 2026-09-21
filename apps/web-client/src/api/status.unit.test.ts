import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadInstallationStatus } from './status.ts';

const DEPLOYMENT = {
  application: {
    version: '1.0.0',
    modules: ['core-security', 'rooms-documents', 'participants-access'],
    adapters: { storage: 's3-compatible', mail: 'smtp', identity: 'oidc' },
  },
  oidc: { discoveryConformedAt: '2026-09-21T08:00:00.000Z' },
  migrations: { state: 'current', appliedCount: 14, expectedCount: 14, latestApplied: '026_x' },
  queue: { due: 0, running: 0, failedRecently: 0, oldestDueSeconds: null },
  mail: { lastDeliveredAt: null, failedRecently: 0 },
  checks: [
    { check: 'storage-privacy', observation: null },
    { check: 'storage-versioning', observation: null },
    {
      check: 'scanner',
      observation: {
        result: 'pass',
        code: 'SIGNATURES_CURRENT',
        evidenceAt: '2026-09-21T06:00:00.000Z',
        evidenceVersion: null,
        observedAt: '2026-09-21T09:00:00.000Z',
        stale: false,
      },
    },
    { check: 'updates', observation: null },
  ],
};

const CONTENT = {
  processing: { failedCount: 0 },
  recovery: {
    backupStatus: 'undetermined',
    backupRetention: null,
    recoveryExpectation: null,
    acknowledgedAt: null,
    restoreDrillStatus: 'not-tested',
    restoreDrillAt: null,
  },
};

function answering(deployment: unknown, content: unknown = CONTENT): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : 'url' in input ? input.url : input.href;
      return Promise.resolve(
        new Response(
          JSON.stringify(url.endsWith('/api/status/content') ? content : deployment),
          { status: 200 },
        ),
      );
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadInstallationStatus', () => {
  it('reads both routes as one answer', async () => {
    answering(DEPLOYMENT);
    const status = await loadInstallationStatus();
    expect(status.deployment.checks[2]?.observation?.code).toBe('SIGNATURES_CURRENT');
    expect(status.content.recovery.restoreDrillStatus).toBe('not-tested');
  });

  it.each([
    ['a code that belongs to another check', 2, { code: 'UPDATE_AVAILABLE' }],
    ['a result it does not know', 2, { result: 'unknown' }],
    ['an unreadable instant', 2, { observedAt: 'yesterday' }],
  ] as const)('fails closed on %s', async (_label, index, change) => {
    const checks = DEPLOYMENT.checks.map((row, position) =>
      position === index && row.observation !== null
        ? { ...row, observation: { ...row.observation, ...change } }
        : row,
    );
    answering({ ...DEPLOYMENT, checks });
    await expect(loadInstallationStatus()).rejects.toMatchObject({ failure: 'unavailable' });
  });

  it('fails closed when a check is missing or out of order', async () => {
    answering({ ...DEPLOYMENT, checks: DEPLOYMENT.checks.slice(1) });
    await expect(loadInstallationStatus()).rejects.toMatchObject({ failure: 'unavailable' });
    answering({ ...DEPLOYMENT, checks: [...DEPLOYMENT.checks].reverse() });
    await expect(loadInstallationStatus()).rejects.toMatchObject({ failure: 'unavailable' });
  });

  it('fails closed on a recovery state it does not know', async () => {
    answering(DEPLOYMENT, {
      ...CONTENT,
      recovery: { ...CONTENT.recovery, restoreDrillStatus: 'maybe' },
    });
    await expect(loadInstallationStatus()).rejects.toMatchObject({ failure: 'unavailable' });
  });

  it.each([
    [
      'fractional appliedCount in migrations',
      { migrations: { ...DEPLOYMENT.migrations, appliedCount: 14.5 } },
    ],
    [
      'fractional expectedCount in migrations',
      { migrations: { ...DEPLOYMENT.migrations, expectedCount: 14.2 } },
    ],
    ['fractional due in queue', { queue: { ...DEPLOYMENT.queue, due: 1.5 } }],
    ['fractional running in queue', { queue: { ...DEPLOYMENT.queue, running: 2.5 } }],
    [
      'fractional failedRecently in queue',
      { queue: { ...DEPLOYMENT.queue, failedRecently: 0.1 } },
    ],
    [
      'fractional oldestDueSeconds in queue',
      { queue: { ...DEPLOYMENT.queue, oldestDueSeconds: 15.5 } },
    ],
    [
      'fractional failedRecently in mail',
      { mail: { ...DEPLOYMENT.mail, failedRecently: 1.9 } },
    ],
  ])('fails closed on %s', async (_label, override) => {
    answering({ ...DEPLOYMENT, ...override });
    await expect(loadInstallationStatus()).rejects.toMatchObject({ failure: 'unavailable' });
  });

  it('fails closed on fractional failedCount in content processing', async () => {
    answering(DEPLOYMENT, {
      ...CONTENT,
      processing: { failedCount: 2.7 },
    });
    await expect(loadInstallationStatus()).rejects.toMatchObject({ failure: 'unavailable' });
  });

  it.each([
    [
      'missing application version',
      { application: { ...DEPLOYMENT.application, version: '' } },
      undefined,
    ],
    [
      'empty module entry',
      { application: { ...DEPLOYMENT.application, modules: [''] } },
      undefined,
    ],
    [
      'missing storage adapter',
      {
        application: {
          ...DEPLOYMENT.application,
          adapters: { ...DEPLOYMENT.application.adapters, storage: '' },
        },
      },
      undefined,
    ],
    [
      'missing oidc discovery instant',
      { oidc: { discoveryConformedAt: 'not-a-date' } },
      undefined,
    ],
    [
      'unknown migration state',
      { migrations: { ...DEPLOYMENT.migrations, state: 'unknown' } },
      undefined,
    ],
    [
      'unknown backup status',
      {},
      { ...CONTENT, recovery: { ...CONTENT.recovery, backupStatus: 'unknown' } },
    ],
  ])('fails closed on %s', async (_label, deploymentOverride, contentOverride) => {
    answering(
      { ...DEPLOYMENT, ...deploymentOverride },
      contentOverride ? { ...CONTENT, ...contentOverride } : CONTENT,
    );
    await expect(loadInstallationStatus()).rejects.toMatchObject({ failure: 'unavailable' });
  });

  it('fails closed when response is not an object', async () => {
    answering(null);
    await expect(loadInstallationStatus()).rejects.toMatchObject({ failure: 'unavailable' });
    answering(DEPLOYMENT, 'not a record');
    await expect(loadInstallationStatus()).rejects.toMatchObject({ failure: 'unavailable' });
  });
});
