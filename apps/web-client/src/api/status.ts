/**
 * The Owner/Admin status surface: `GET /api/status` and `GET /api/status/content`, read as one
 * answer and parsed field by field. A check, code, order or state this client does not know
 * fails the read rather than being shown as something else.
 */
import {
  CHECK_CODES,
  STATUS_CHECKS,
  type ObservationCode,
  type StatusCheck,
} from './status-codes.ts';
import {
  ApiError,
  instantOrNull,
  isRecord,
  json,
  oneOf,
  requireArray,
  requireBoolean,
  requireInteger,
  requireRecord,
  requireString,
  textOrNull,
} from './transport.ts';

export type { ObservationCode, StatusCheck } from './status-codes.ts';
export type ObservationResult = 'pass' | 'attention' | 'fail';
export type MigrationState = 'current' | 'pending' | 'unrecognized';
export type BackupStatus = 'undetermined' | 'operator-acknowledged';
export type RestoreDrillStatus = 'not-tested' | 'passed' | 'failed';

export interface CheckObservation {
  readonly result: ObservationResult;
  readonly code: ObservationCode;
  readonly evidenceAt: string | null;
  readonly evidenceVersion: string | null;
  readonly observedAt: string;
  readonly stale: boolean;
}

export interface StatusCheckRow {
  readonly check: StatusCheck;
  readonly observation: CheckObservation | null;
}

export interface DeploymentStatus {
  readonly application: {
    readonly version: string;
    readonly modules: readonly string[];
    readonly adapters: {
      readonly storage: string;
      readonly mail: string;
      readonly identity: string;
    };
  };
  readonly oidc: { readonly discoveryConformedAt: string };
  readonly migrations: {
    readonly state: MigrationState;
    readonly appliedCount: number;
    readonly expectedCount: number;
    readonly latestApplied: string | null;
  };
  readonly queue: {
    readonly due: number;
    readonly running: number;
    readonly failedRecently: number;
    readonly oldestDueSeconds: number | null;
  };
  readonly mail: { readonly lastDeliveredAt: string | null; readonly failedRecently: number };
  readonly checks: readonly StatusCheckRow[];
}

export interface ContentStatus {
  readonly processing: { readonly failedCount: number };
  readonly recovery: {
    readonly backupStatus: BackupStatus;
    readonly backupRetention: string | null;
    readonly recoveryExpectation: string | null;
    readonly acknowledgedAt: string | null;
    readonly restoreDrillStatus: RestoreDrillStatus;
    readonly restoreDrillAt: string | null;
  };
}

export interface InstallationStatus {
  readonly deployment: DeploymentStatus;
  readonly content: ContentStatus;
}

const RESULTS: readonly ObservationResult[] = ['pass', 'attention', 'fail'];
const MIGRATION_STATES: readonly MigrationState[] = ['current', 'pending', 'unrecognized'];
const BACKUP_STATES: readonly BackupStatus[] = ['undetermined', 'operator-acknowledged'];
const RESTORE_STATES: readonly RestoreDrillStatus[] = ['not-tested', 'passed', 'failed'];

function requireInstant(value: unknown): string {
  const instant = instantOrNull(value);
  if (instant === null) throw new ApiError('unavailable');
  return instant;
}

function integerOrNull(value: Readonly<Record<string, unknown>>, key: string): number | null {
  return value[key] === null ? null : requireInteger(value, key);
}

function parseCheck(value: unknown, expected: StatusCheck | undefined): StatusCheckRow {
  if (!isRecord(value) || expected === undefined || value['check'] !== expected)
    throw new ApiError('unavailable');
  const observation = value['observation'];
  if (observation === null) return { check: expected, observation: null };
  if (!isRecord(observation)) throw new ApiError('unavailable');
  return {
    check: expected,
    observation: {
      result: oneOf(RESULTS, observation['result']),
      code: oneOf<ObservationCode>(CHECK_CODES[expected], observation['code']),
      evidenceAt: instantOrNull(observation['evidenceAt']),
      evidenceVersion: textOrNull(observation['evidenceVersion']),
      observedAt: requireInstant(observation['observedAt']),
      stale: requireBoolean(observation, 'stale'),
    },
  };
}

function parseDeployment(value: unknown): DeploymentStatus {
  if (!isRecord(value)) throw new ApiError('unavailable');
  const application = requireRecord(value, 'application');
  const adapters = requireRecord(application, 'adapters');
  const migrations = requireRecord(value, 'migrations');
  const queue = requireRecord(value, 'queue');
  const mail = requireRecord(value, 'mail');
  const checks = requireArray(value, 'checks');
  /* The server answers every check, in one order; anything else is not its answer. */
  if (checks.length !== STATUS_CHECKS.length) throw new ApiError('unavailable');
  return {
    application: {
      version: requireString(application, 'version'),
      modules: requireArray(application, 'modules').map((module) => {
        if (typeof module !== 'string' || module === '') throw new ApiError('unavailable');
        return module;
      }),
      adapters: {
        storage: requireString(adapters, 'storage'),
        mail: requireString(adapters, 'mail'),
        identity: requireString(adapters, 'identity'),
      },
    },
    oidc: {
      discoveryConformedAt: requireInstant(
        requireRecord(value, 'oidc')['discoveryConformedAt'],
      ),
    },
    migrations: {
      state: oneOf(MIGRATION_STATES, migrations['state']),
      appliedCount: requireInteger(migrations, 'appliedCount'),
      expectedCount: requireInteger(migrations, 'expectedCount'),
      latestApplied: textOrNull(migrations['latestApplied']),
    },
    queue: {
      due: requireInteger(queue, 'due'),
      running: requireInteger(queue, 'running'),
      failedRecently: requireInteger(queue, 'failedRecently'),
      oldestDueSeconds: integerOrNull(queue, 'oldestDueSeconds'),
    },
    mail: {
      lastDeliveredAt: instantOrNull(mail['lastDeliveredAt']),
      failedRecently: requireInteger(mail, 'failedRecently'),
    },
    checks: checks.map((check, index) => parseCheck(check, STATUS_CHECKS[index])),
  };
}

function parseContent(value: unknown): ContentStatus {
  if (!isRecord(value)) throw new ApiError('unavailable');
  const recovery = requireRecord(value, 'recovery');
  return {
    processing: {
      failedCount: requireInteger(requireRecord(value, 'processing'), 'failedCount'),
    },
    recovery: {
      backupStatus: oneOf(BACKUP_STATES, recovery['backupStatus']),
      backupRetention: textOrNull(recovery['backupRetention']),
      recoveryExpectation: textOrNull(recovery['recoveryExpectation']),
      acknowledgedAt: instantOrNull(recovery['acknowledgedAt']),
      restoreDrillStatus: oneOf(RESTORE_STATES, recovery['restoreDrillStatus']),
      restoreDrillAt: instantOrNull(recovery['restoreDrillAt']),
    },
  };
}

export async function loadInstallationStatus(
  signal?: AbortSignal,
): Promise<InstallationStatus> {
  const options = signal === undefined ? {} : { signal };
  const [deployment, content] = await Promise.all([
    json({ method: 'GET', path: '/api/status', ...options }),
    json({ method: 'GET', path: '/api/status/content', ...options }),
  ]);
  return { deployment: parseDeployment(deployment), content: parseContent(content) };
}
