/**
 * The Status section's rows, in §20.2's order, from what the server returned. Pure, so every
 * wording and state decision is tested without a browser.
 */
import type {
  CheckObservation,
  InstallationStatus,
  ObservationCode,
  StatusCheck,
} from '../api/client.ts';
import { translate, type MessageKey } from '../i18n/translate.ts';

export type RowState = 'pass' | 'attention' | 'fail' | 'unchecked' | 'stale';

/** What instant a row speaks for: read just now, recorded at an instant, or never recorded. */
export type RowTime =
  | { readonly kind: 'now' }
  | { readonly kind: 'at'; readonly iso: string }
  | { readonly kind: 'never' };

export interface StatusRow {
  readonly id: string;
  readonly label: MessageKey;
  readonly state: RowState;
  readonly details: readonly string[];
  readonly time: RowTime;
}

export const STATE_LABEL: Readonly<Record<RowState, MessageKey>> = {
  pass: 'status.state.pass',
  attention: 'status.state.attention',
  fail: 'status.state.fail',
  unchecked: 'status.state.unchecked',
  stale: 'status.state.stale',
};

const CHECK_LABEL: Readonly<Record<StatusCheck, MessageKey>> = {
  'storage-privacy': 'status.row.storagePrivacy',
  'storage-versioning': 'status.row.storageVersioning',
  scanner: 'status.row.scanner',
  updates: 'status.row.updates',
};

const CODE_COPY: Readonly<Record<ObservationCode, MessageKey>> = {
  ANONYMOUS_ACCESS_REFUSED: 'status.code.ANONYMOUS_ACCESS_REFUSED',
  ANONYMOUS_READ_ALLOWED: 'status.code.ANONYMOUS_READ_ALLOWED',
  ANONYMOUS_LIST_ALLOWED: 'status.code.ANONYMOUS_LIST_ALLOWED',
  STORAGE_PROBE_INCONCLUSIVE: 'status.code.STORAGE_PROBE_INCONCLUSIVE',
  STORAGE_UNREACHABLE: 'status.code.STORAGE_UNREACHABLE',
  VERSIONING_ENABLED: 'status.code.VERSIONING_ENABLED',
  VERSIONING_SUSPENDED: 'status.code.VERSIONING_SUSPENDED',
  VERSIONING_NEVER_ENABLED: 'status.code.VERSIONING_NEVER_ENABLED',
  VERSIONING_NOT_DETECTABLE: 'status.code.VERSIONING_NOT_DETECTABLE',
  SIGNATURES_CURRENT: 'status.code.SIGNATURES_CURRENT',
  SIGNATURES_STALE: 'status.code.SIGNATURES_STALE',
  SCANNER_UNAVAILABLE: 'status.code.SCANNER_UNAVAILABLE',
  UPDATE_CURRENT: 'status.code.UPDATE_CURRENT',
  UPDATE_AVAILABLE: 'status.code.UPDATE_AVAILABLE',
  SECURITY_ADVISORY: 'status.code.SECURITY_ADVISORY',
  UPDATE_MANIFEST_UNVERIFIED: 'status.code.UPDATE_MANIFEST_UNVERIFIED',
  UPDATE_VERSION_UNRECOGNIZED: 'status.code.UPDATE_VERSION_UNRECOGNIZED',
};

const MIGRATION_COPY: Readonly<
  Record<InstallationStatus['deployment']['migrations']['state'], MessageKey>
> = {
  current: 'status.migrations.current',
  pending: 'status.migrations.pending',
  unrecognized: 'status.migrations.unrecognized',
};

const RESTORE: Readonly<
  Record<
    InstallationStatus['content']['recovery']['restoreDrillStatus'],
    { readonly state: RowState; readonly copy: MessageKey }
  >
> = {
  'not-tested': { state: 'attention', copy: 'status.restore.untested' },
  passed: { state: 'pass', copy: 'status.restore.passed' },
  failed: { state: 'fail', copy: 'status.restore.failed' },
};

/** How long due work may wait before the queue reads as backed up. */
const BACKLOG_SECONDS = 15 * 60;
const NOW: RowTime = { kind: 'now' };
const recorded = (iso: string | null): RowTime =>
  iso === null ? { kind: 'never' } : { kind: 'at', iso };

/** A server instant in the reader's locale; the ISO value stays available beside it. */
export function formatInstant(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Whole days between two server instants, never the browser's clock. */
function wholeDays(later: string, earlier: string): number {
  return Math.max(0, Math.floor((Date.parse(later) - Date.parse(earlier)) / 86_400_000));
}

function observationRow(check: StatusCheck, observation: CheckObservation | null): StatusRow {
  if (observation === null)
    return {
      id: check,
      label: CHECK_LABEL[check],
      state: 'unchecked',
      details: [
        translate(check === 'updates' ? 'status.unchecked.updates' : 'status.unchecked.worker'),
      ],
      time: { kind: 'never' },
    };
  const details = [translate(CODE_COPY[observation.code])];
  if (observation.evidenceAt !== null)
    details.push(
      translate('status.scanner.builtAt', {
        date: formatInstant(observation.evidenceAt),
        days: wholeDays(observation.observedAt, observation.evidenceAt),
      }),
    );
  if (observation.evidenceVersion !== null)
    details.push(translate('status.updates.offered', { version: observation.evidenceVersion }));
  /* The last known answer to a failing check is still failing, however old it is. */
  const state: RowState =
    observation.result === 'fail' ? 'fail' : observation.stale ? 'stale' : observation.result;
  return {
    id: check,
    label: CHECK_LABEL[check],
    state,
    details,
    time: recorded(observation.observedAt),
  };
}

function queueRow({ queue }: InstallationStatus['deployment']): StatusRow {
  const backlogged =
    queue.oldestDueSeconds !== null && queue.oldestDueSeconds > BACKLOG_SECONDS;
  return {
    id: 'queue',
    label: 'status.row.queue',
    state: backlogged || queue.failedRecently > 0 ? 'attention' : 'pass',
    details: [
      translate('status.queue.counts', { due: queue.due, running: queue.running }),
      ...(queue.failedRecently > 0
        ? [translate('status.queue.failed', { count: queue.failedRecently })]
        : []),
      ...(backlogged
        ? [
            translate('status.queue.backlog', {
              minutes: Math.floor(queue.oldestDueSeconds / 60),
            }),
          ]
        : []),
    ],
    time: NOW,
  };
}

function mailRow({ mail }: InstallationStatus['deployment']): StatusRow {
  if (mail.failedRecently > 0)
    return {
      id: 'mail',
      label: 'status.row.mail',
      state: 'fail',
      details: [translate('status.mail.failing', { count: mail.failedRecently })],
      time: recorded(mail.lastDeliveredAt),
    };
  return mail.lastDeliveredAt === null
    ? {
        id: 'mail',
        label: 'status.row.mail',
        state: 'unchecked',
        details: [translate('status.mail.untested')],
        time: { kind: 'never' },
      }
    : {
        id: 'mail',
        label: 'status.row.mail',
        state: 'pass',
        details: [translate('status.mail.delivering')],
        time: recorded(mail.lastDeliveredAt),
      };
}

function backupsRow({ recovery }: InstallationStatus['content']): StatusRow {
  if (recovery.backupStatus === 'undetermined')
    return {
      id: 'backups',
      label: 'status.row.backups',
      state: 'attention',
      details: [translate('status.backups.undetermined')],
      time: { kind: 'never' },
    };
  return {
    id: 'backups',
    label: 'status.row.backups',
    state: 'pass',
    details: [
      translate('status.backups.acknowledged'),
      ...(recovery.backupRetention === null
        ? []
        : [translate('status.backups.retention', { retention: recovery.backupRetention })]),
      ...(recovery.recoveryExpectation === null
        ? []
        : [
            translate('status.backups.expectation', {
              expectation: recovery.recoveryExpectation,
            }),
          ]),
    ],
    time: recorded(recovery.acknowledgedAt),
  };
}

export function statusRows(status: InstallationStatus): readonly StatusRow[] {
  const { deployment, content } = status;
  const check = (name: StatusCheck): StatusRow =>
    observationRow(
      name,
      deployment.checks.find((row) => row.check === name)?.observation ?? null,
    );
  const { application, migrations } = deployment;
  return [
    {
      id: 'application',
      label: 'status.row.application',
      state: 'pass',
      details: [
        translate('status.application.version', { version: application.version }),
        translate('status.application.modules', { installed: application.modules.join(', ') }),
        translate('status.application.adapters', { ...application.adapters }),
      ],
      time: NOW,
    },
    {
      id: 'migrations',
      label: 'status.row.migrations',
      state: migrations.state === 'current' ? 'pass' : 'fail',
      details: [
        translate(MIGRATION_COPY[migrations.state], {
          applied: migrations.appliedCount,
          expected: migrations.expectedCount,
        }),
        ...(migrations.latestApplied === null
          ? []
          : [translate('status.migrations.latest', { id: migrations.latestApplied })]),
      ],
      time: NOW,
    },
    check('storage-privacy'),
    check('storage-versioning'),
    check('scanner'),
    queueRow(deployment),
    {
      id: 'processing',
      label: 'status.row.processing',
      state: content.processing.failedCount > 0 ? 'attention' : 'pass',
      details: [
        content.processing.failedCount > 0
          ? translate('status.processing.failed', { count: content.processing.failedCount })
          : translate('status.processing.none'),
      ],
      time: NOW,
    },
    {
      id: 'oidc',
      label: 'status.row.oidc',
      state: 'pass',
      details: [translate('status.oidc.conformed')],
      time: recorded(deployment.oidc.discoveryConformedAt),
    },
    mailRow(deployment),
    backupsRow(content),
    {
      id: 'restore',
      label: 'status.row.restore',
      state: RESTORE[content.recovery.restoreDrillStatus].state,
      details: [translate(RESTORE[content.recovery.restoreDrillStatus].copy)],
      time: recorded(content.recovery.restoreDrillAt),
    },
    check('updates'),
  ];
}
