import { describe, expect, it } from 'vitest';
import type {
  CheckObservation,
  InstallationStatus,
  ObservationCode,
  StatusCheck,
} from '../api/client.ts';
import { CHECK_CODES } from '../api/status-codes.ts';
import { messages } from '../i18n/en.ts';
import { formatInstant, statusRows } from './status-rows.ts';

const STATUS: InstallationStatus = {
  deployment: {
    application: {
      version: '1.0.0',
      modules: ['core-security', 'rooms-documents'],
      adapters: { storage: 's3-compatible', mail: 'smtp', identity: 'oidc' },
    },
    oidc: { discoveryConformedAt: '2026-09-21T08:00:00.000Z' },
    migrations: {
      state: 'current',
      appliedCount: 14,
      expectedCount: 14,
      latestApplied: '026_x',
    },
    queue: { due: 0, running: 0, failedRecently: 0, oldestDueSeconds: null },
    mail: { lastDeliveredAt: '2026-09-21T07:00:00.000Z', failedRecently: 0 },
    checks: [
      { check: 'storage-privacy', observation: null },
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

const row = (status: InstallationStatus, id: string) =>
  statusRows(status).find((candidate) => candidate.id === id);

const withCheck = (
  check: InstallationStatus['deployment']['checks'][number],
): InstallationStatus => ({
  ...STATUS,
  deployment: {
    ...STATUS.deployment,
    checks: STATUS.deployment.checks.map((r) => (r.check === check.check ? check : r)),
  },
});

describe('statusRows', () => {
  it("lists §20.2's facts in order", () => {
    expect(statusRows(STATUS).map(({ id }) => id)).toStrictEqual([
      'application',
      'migrations',
      'storage-privacy',
      'storage-versioning',
      'scanner',
      'queue',
      'processing',
      'oidc',
      'mail',
      'backups',
      'restore',
      'updates',
    ]);
  });

  it('says a check that never ran is not yet checked, and when it will be', () => {
    expect(row(STATUS, 'scanner')).toMatchObject({
      state: 'unchecked',
      details: [messages['status.unchecked.worker']],
      time: { kind: 'never' },
    });
    expect(row(STATUS, 'updates')?.details).toStrictEqual([
      messages['status.unchecked.updates'],
    ]);
  });

  it('keeps a failing check failing when it is also out of date, and otherwise reports it out of date', () => {
    const observation = {
      result: 'fail',
      code: 'SIGNATURES_STALE',
      evidenceAt: '2026-09-18T09:00:00.000Z',
      evidenceVersion: null,
      observedAt: '2026-09-21T09:00:00.000Z',
      stale: true,
    } as const;
    expect(row(withCheck({ check: 'scanner', observation }), 'scanner')?.state).toBe('fail');
    expect(
      row(
        withCheck({
          check: 'scanner',
          observation: { ...observation, result: 'pass', code: 'SIGNATURES_CURRENT' },
        }),
        'scanner',
      )?.state,
    ).toBe('stale');
    expect(
      row(
        withCheck({
          check: 'storage-privacy',
          observation: {
            result: 'attention',
            code: 'STORAGE_PROBE_INCONCLUSIVE',
            evidenceAt: null,
            evidenceVersion: null,
            observedAt: '2026-09-21T09:00:00.000Z',
            stale: true,
          },
        }),
        'storage-privacy',
      )?.state,
    ).toBe('stale');
  });

  it("gives the signatures' age in whole days between two server instants", () => {
    const scanner = row(
      withCheck({
        check: 'scanner',
        observation: {
          result: 'fail',
          code: 'SIGNATURES_STALE',
          evidenceAt: '2026-09-18T09:00:00.000Z',
          evidenceVersion: null,
          observedAt: '2026-09-21T10:00:00.000Z',
          stale: false,
        },
      }),
      'scanner',
    );
    expect(scanner?.details[0]).toBe(messages['status.code.SIGNATURES_STALE']);
    expect(scanner?.details[1]).toContain('3 days before');
  });

  it('names the offered release', () => {
    const updates = row(
      withCheck({
        check: 'updates',
        observation: {
          result: 'attention',
          code: 'UPDATE_AVAILABLE',
          evidenceAt: null,
          evidenceVersion: '1.2.0',
          observedAt: '2026-09-21T10:00:00.000Z',
          stale: false,
        },
      }),
      'updates',
    );
    expect(updates?.state).toBe('attention');
    expect(updates?.details.join(' ')).toContain('1.2.0');
  });

  it('fails the migrations row unless the ledger is current', () => {
    expect(row(STATUS, 'migrations')?.state).toBe('pass');
    expect(
      row(
        {
          ...STATUS,
          deployment: {
            ...STATUS.deployment,
            migrations: { ...STATUS.deployment.migrations, state: 'pending', appliedCount: 12 },
          },
        },
        'migrations',
      )?.state,
    ).toBe('fail');
    expect(
      row(
        {
          ...STATUS,
          deployment: {
            ...STATUS.deployment,
            migrations: {
              ...STATUS.deployment.migrations,
              state: 'unrecognized',
              appliedCount: 15,
            },
          },
        },
        'migrations',
      )?.state,
    ).toBe('fail');
  });

  it('asks for attention when work has waited a quarter of an hour or failed after every retry', () => {
    const queue = (change: Partial<InstallationStatus['deployment']['queue']>) =>
      row(
        {
          ...STATUS,
          deployment: {
            ...STATUS.deployment,
            queue: { ...STATUS.deployment.queue, ...change },
          },
        },
        'queue',
      )?.state;
    expect(queue({ due: 3, oldestDueSeconds: 60 })).toBe('pass');
    expect(queue({ due: 3, oldestDueSeconds: 16 * 60 })).toBe('attention');
    expect(queue({ failedRecently: 1 })).toBe('attention');
  });

  it('reads mail from delivery evidence', () => {
    const mail = (change: Partial<InstallationStatus['deployment']['mail']>) =>
      row(
        {
          ...STATUS,
          deployment: { ...STATUS.deployment, mail: { ...STATUS.deployment.mail, ...change } },
        },
        'mail',
      )?.state;
    expect(mail({})).toBe('pass');
    expect(mail({ lastDeliveredAt: null })).toBe('unchecked');
    expect(mail({ failedRecently: 2 })).toBe('fail');
  });

  it('asks for attention until backups are acknowledged and a restore drill has passed', () => {
    expect(row(STATUS, 'backups')?.state).toBe('attention');
    expect(row(STATUS, 'restore')?.state).toBe('attention');
    const recovered: InstallationStatus = {
      ...STATUS,
      content: {
        ...STATUS.content,
        recovery: {
          backupStatus: 'operator-acknowledged',
          backupRetention: '35 days',
          recoveryExpectation: 'Four hours',
          acknowledgedAt: '2026-09-20T09:00:00.000Z',
          restoreDrillStatus: 'failed',
          restoreDrillAt: '2026-09-20T10:00:00.000Z',
        },
      },
    };
    expect(row(recovered, 'backups')).toMatchObject({
      state: 'pass',
      time: { kind: 'at', iso: '2026-09-20T09:00:00.000Z' },
    });
    expect(row(recovered, 'backups')?.details.join(' ')).toContain('35 days');
    expect(row(recovered, 'restore')?.state).toBe('fail');

    const restorePassed: InstallationStatus = {
      ...recovered,
      content: {
        ...recovered.content,
        recovery: {
          ...recovered.content.recovery,
          restoreDrillStatus: 'passed',
        },
      },
    };
    expect(row(restorePassed, 'restore')?.state).toBe('pass');
  });

  it('reports processing status according to failedCount', () => {
    expect(row(STATUS, 'processing')?.state).toBe('pass');
    expect(row(STATUS, 'processing')?.details).toStrictEqual([
      messages['status.processing.none'],
    ]);

    const failedProcessing: InstallationStatus = {
      ...STATUS,
      content: {
        ...STATUS.content,
        processing: { failedCount: 3 },
      },
    };
    expect(row(failedProcessing, 'processing')?.state).toBe('attention');
    expect(row(failedProcessing, 'processing')?.details[0]).toContain('3');
  });

  it('maps every one of the 17 observation codes to the expected copy and state', () => {
    const checks: StatusCheck[] = [
      'storage-privacy',
      'storage-versioning',
      'scanner',
      'updates',
    ];
    const expectedStates: Record<ObservationCode, 'pass' | 'attention' | 'fail'> = {
      ANONYMOUS_ACCESS_REFUSED: 'pass',
      ANONYMOUS_READ_ALLOWED: 'fail',
      ANONYMOUS_LIST_ALLOWED: 'fail',
      STORAGE_PROBE_INCONCLUSIVE: 'attention',
      STORAGE_UNREACHABLE: 'fail',
      VERSIONING_ENABLED: 'pass',
      VERSIONING_SUSPENDED: 'attention',
      VERSIONING_NEVER_ENABLED: 'attention',
      VERSIONING_NOT_DETECTABLE: 'attention',
      SIGNATURES_CURRENT: 'pass',
      SIGNATURES_STALE: 'fail',
      SCANNER_UNAVAILABLE: 'fail',
      UPDATE_CURRENT: 'pass',
      UPDATE_AVAILABLE: 'attention',
      SECURITY_ADVISORY: 'fail',
      UPDATE_MANIFEST_UNVERIFIED: 'fail',
      UPDATE_VERSION_UNRECOGNIZED: 'attention',
    };

    let totalTested = 0;
    for (const check of checks) {
      for (const code of CHECK_CODES[check]) {
        totalTested += 1;
        const observation: CheckObservation = {
          result: expectedStates[code],
          code,
          evidenceAt: check === 'scanner' ? '2026-09-20T00:00:00.000Z' : null,
          evidenceVersion: check === 'updates' ? '1.5.0' : null,
          observedAt: '2026-09-21T00:00:00.000Z',
          stale: false,
        };
        const current = row(withCheck({ check, observation }), check);
        expect(current).toBeDefined();
        expect(current?.state).toBe(expectedStates[code]);
        expect(current?.details[0]).toBe(
          messages[`status.code.${code}` as keyof typeof messages],
        );
      }
    }
    expect(totalTested).toBe(18);
  });
});

describe('formatInstant', () => {
  it('formats valid ISO timestamps', () => {
    const formatted = formatInstant('2026-09-21T08:00:00.000Z');
    expect(typeof formatted).toBe('string');
    expect(formatted.length).toBeGreaterThan(0);
  });

  it('returns invalid strings unchanged', () => {
    expect(formatInstant('invalid-date')).toBe('invalid-date');
  });
});
