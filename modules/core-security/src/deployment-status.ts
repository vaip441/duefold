/**
 * The deployment half of the status surface: what this process was built from, and what
 * PostgreSQL says about migrations, the job queue, mail delivery and the observations.
 */
import type { Pool } from 'pg';
import type { MemberIdentity } from './authorization.ts';
import { compareReleaseVersions } from './release.ts';
import type { ObservationResult, StatusCheck } from './status-observations.ts';

/** Injected through `WebRuntime`: a module does not read the composed registry itself. */
export interface DeploymentFacts {
  readonly applicationVersion: string;
  readonly modules: readonly string[];
  readonly adapters: {
    readonly storage: string;
    readonly mail: string;
    readonly identity: string;
  };
  readonly expectedMigrationIds: readonly string[];
  /** When OIDC discovery and client-authentication negotiation passed at startup. */
  readonly oidcDiscoveryConformedAt: string;
}

export type MigrationState = 'current' | 'pending' | 'unrecognized';

export interface MigrationStatus {
  readonly state: MigrationState;
  readonly appliedCount: number;
  readonly expectedCount: number;
  readonly latestApplied: string | null;
}

/**
 * `pending` only when the ledger is a strict prefix of the registry, which is what an image
 * newer than its database looks like. Any other difference is `unrecognized`: this image did
 * not produce that ledger. Ordered the way `migrate` applies them.
 */
export function migrationStatus(
  applied: readonly string[],
  expected: readonly string[],
): MigrationStatus {
  const registry = [...expected].sort((left, right) => left.localeCompare(right));
  const prefix =
    applied.length <= registry.length && applied.every((id, index) => registry[index] === id);
  return {
    state: !prefix
      ? 'unrecognized'
      : applied.length === registry.length
        ? 'current'
        : 'pending',
    appliedCount: applied.length,
    expectedCount: registry.length,
    latestApplied: applied.at(-1) ?? null,
  };
}

export interface CheckObservation {
  readonly result: ObservationResult;
  readonly code: string;
  readonly evidenceAt: string | null;
  readonly evidenceVersion: string | null;
  readonly observedAt: string;
  readonly stale: boolean;
}

/**
 * An update check compares the offered release with the one running when it was made. Once
 * the offered release is installed the offer no longer stands, whatever it said.
 */
export function presentUpdateObservation(
  observation: CheckObservation,
  runningVersion: string,
): CheckObservation {
  if (observation.evidenceVersion === null) return observation;
  const order = compareReleaseVersions(observation.evidenceVersion, runningVersion);
  return order !== null && order <= 0
    ? { ...observation, result: 'pass', code: 'UPDATE_CURRENT', evidenceVersion: null }
    : observation;
}

export interface StatusCheckRow {
  readonly check: StatusCheck;
  /** Null when the check has never run. */
  readonly observation: CheckObservation | null;
}

export interface DeploymentStatus {
  readonly application: {
    readonly version: string;
    readonly modules: readonly string[];
    readonly adapters: DeploymentFacts['adapters'];
  };
  readonly oidc: { readonly discoveryConformedAt: string };
  readonly migrations: MigrationStatus;
  readonly queue: {
    readonly due: number;
    readonly running: number;
    readonly failedRecently: number;
    readonly oldestDueSeconds: number | null;
  };
  readonly mail: { readonly lastDeliveredAt: string | null; readonly failedRecently: number };
  readonly checks: readonly StatusCheckRow[];
}

interface DeploymentRow {
  readonly applied_migrations: string[];
  readonly jobs_due: number;
  readonly jobs_running: number;
  readonly jobs_failed_recently: number;
  readonly oldest_due_seconds: number | null;
  readonly mail_delivered_at: Date | null;
  readonly mail_failed_recently: number;
}

interface ObservationRow {
  readonly check_name: StatusCheck;
  readonly result: ObservationResult | null;
  readonly code: string | null;
  readonly evidence_at: Date | null;
  readonly evidence_version: string | null;
  readonly observed_at: Date | null;
  readonly stale: boolean;
}

function observationOf(row: ObservationRow, runningVersion: string): CheckObservation | null {
  if (row.result === null || row.code === null || row.observed_at === null) return null;
  const observation: CheckObservation = {
    result: row.result,
    code: row.code,
    evidenceAt: row.evidence_at?.toISOString() ?? null,
    evidenceVersion: row.evidence_version,
    observedAt: row.observed_at.toISOString(),
    stale: row.stale,
  };
  return row.check_name === 'updates'
    ? presentUpdateObservation(observation, runningVersion)
    : observation;
}

export async function readDeploymentStatus(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly facts: DeploymentFacts;
}): Promise<DeploymentStatus> {
  /*
   * Two independent reads, issued together: each authorizes for itself in SQL, and neither
   * derives a value from the other, so there is nothing for an interleaved write to tear.
   * A status surface reports the latest answer of each check, not one instant.
   */
  const [deployment, observations] = await Promise.all([
    input.pool.query<DeploymentRow>('SELECT * FROM read_deployment_status($1)', [
      input.identity.id,
    ]),
    input.pool.query<ObservationRow>('SELECT * FROM read_status_observations($1)', [
      input.identity.id,
    ]),
  ]);
  const row = deployment.rows[0];
  if (row === undefined) throw new Error('DEPLOYMENT_STATUS_UNAVAILABLE');
  return {
    application: {
      version: input.facts.applicationVersion,
      modules: input.facts.modules,
      adapters: input.facts.adapters,
    },
    oidc: { discoveryConformedAt: input.facts.oidcDiscoveryConformedAt },
    migrations: migrationStatus(row.applied_migrations, input.facts.expectedMigrationIds),
    queue: {
      due: row.jobs_due,
      running: row.jobs_running,
      failedRecently: row.jobs_failed_recently,
      oldestDueSeconds: row.oldest_due_seconds,
    },
    mail: {
      lastDeliveredAt: row.mail_delivered_at?.toISOString() ?? null,
      failedRecently: row.mail_failed_recently,
    },
    checks: observations.rows.map((observation) => ({
      check: observation.check_name,
      observation: observationOf(observation, input.facts.applicationVersion),
    })),
  };
}
