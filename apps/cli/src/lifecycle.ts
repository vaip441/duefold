import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { generatedMigrations } from '../../../.duefold/generated/migrations.ts';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import type { Pool } from 'pg';
import { compareReleaseVersions } from '../../../modules/core-security/src/release.ts';
import type { UpdateObservation } from '../../../modules/core-security/src/status-observations.ts';

export interface SupportBundle {
  readonly formatVersion: 1;
  readonly generatedAt: string;
  readonly migrationCount: number;
  readonly latestMigration: string | null;
  readonly jobCounts: Readonly<Record<string, number>>;
  readonly recovery: {
    readonly backupStatus: 'undetermined' | 'operator-acknowledged';
    readonly restoreDrillStatus: 'not-tested' | 'passed' | 'failed';
    readonly recoveryExpectationRecorded: boolean;
  };
  readonly unreconciledDeletionMarkerCount: number;
}

/** Aggregate operational facts only: no room, document, viewer, audit detail, or config. */
export async function createSupportBundle(
  pool: Pool,
  now = new Date(),
): Promise<SupportBundle> {
  const migrations = await pool.query<{ count: number; latest: string | null }>(
    'SELECT count(*)::int count,max(id) latest FROM duefold_migration',
  );
  const jobs = await pool.query<{ state: string; count: number }>(
    'SELECT state,count(*)::int count FROM job_queue GROUP BY state ORDER BY state',
  );
  const recovery = (
    await pool.query<{
      backup_status: 'undetermined' | 'operator-acknowledged';
      restore_drill_status: 'not-tested' | 'passed' | 'failed';
      recovery_expectation: string | null;
    }>(
      'SELECT backup_status,restore_drill_status,recovery_expectation FROM operational_recovery_status WHERE singleton',
    )
  ).rows[0];
  if (recovery === undefined) throw new Error('RECOVERY_STATUS_ABSENT');
  const markers = await pool.query<{ count: number }>(
    'SELECT count(*)::int count FROM unreconciled_deletion_markers()',
  );
  return {
    formatVersion: 1,
    generatedAt: now.toISOString(),
    migrationCount: migrations.rows[0]?.count ?? 0,
    latestMigration: migrations.rows[0]?.latest ?? null,
    jobCounts: Object.fromEntries(jobs.rows.map(({ state, count }) => [state, count])),
    recovery: {
      backupStatus: recovery.backup_status,
      restoreDrillStatus: recovery.restore_drill_status,
      recoveryExpectationRecorded: recovery.recovery_expectation !== null,
    },
    unreconciledDeletionMarkerCount: markers.rows[0]?.count ?? 0,
  };
}

export interface ReleaseManifestPayload {
  readonly version: string;
  readonly webImageDigest: string;
  readonly workerImageDigest: string;
  readonly securityAdvisory: boolean;
}
export interface ReleaseManifest extends ReleaseManifestPayload {
  readonly signature: string;
}
export function manifestPayload(manifest: ReleaseManifestPayload): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: manifest.version,
      webImageDigest: manifest.webImageDigest,
      workerImageDigest: manifest.workerImageDigest,
      securityAdvisory: manifest.securityAdvisory,
    }),
    'utf8',
  );
}
export function verifyReleaseManifest(raw: string, publicKeyPem: string): ReleaseManifest {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('UPDATE_MANIFEST_INVALID');
  const value = parsed as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(',') !==
      'securityAdvisory,signature,version,webImageDigest,workerImageDigest' ||
    typeof value['version'] !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/u.test(String(value['webImageDigest'])) ||
    !/^sha256:[a-f0-9]{64}$/u.test(String(value['workerImageDigest'])) ||
    typeof value['securityAdvisory'] !== 'boolean' ||
    typeof value['signature'] !== 'string'
  )
    throw new Error('UPDATE_MANIFEST_INVALID');
  const manifest: ReleaseManifest = {
    version: value['version'],
    webImageDigest: value['webImageDigest'] as string,
    workerImageDigest: value['workerImageDigest'] as string,
    securityAdvisory: value['securityAdvisory'],
    signature: value['signature'],
  };
  const ok = verify(
    null,
    manifestPayload(manifest),
    createPublicKey(publicKeyPem),
    Buffer.from(manifest.signature, 'base64url'),
  );
  if (!ok) throw new Error('UPDATE_MANIFEST_SIGNATURE_INVALID');
  return manifest;
}

/**
 * What a signed release manifest says about the running release. A manifest that fails
 * verification is unverified, never trusted or ignored; a release this cannot order is
 * unrecognized, never guessed at.
 */
export function updateObservation(
  raw: string,
  publicKeyPem: string,
  runningVersion: string,
): UpdateObservation {
  let manifest: ReleaseManifest;
  try {
    manifest = verifyReleaseManifest(raw, publicKeyPem);
  } catch (error: unknown) {
    if (
      error instanceof SyntaxError ||
      (error instanceof Error &&
        (error.message === 'UPDATE_MANIFEST_INVALID' ||
          error.message === 'UPDATE_MANIFEST_SIGNATURE_INVALID'))
    )
      return { code: 'UPDATE_MANIFEST_UNVERIFIED', offeredVersion: null };
    throw error;
  }
  const order = compareReleaseVersions(manifest.version, runningVersion);
  if (order === null) return { code: 'UPDATE_VERSION_UNRECOGNIZED', offeredVersion: null };
  if (order <= 0) return { code: 'UPDATE_CURRENT', offeredVersion: null };
  return {
    code: manifest.securityAdvisory ? 'SECURITY_ADVISORY' : 'UPDATE_AVAILABLE',
    offeredVersion: manifest.version,
  };
}

export async function backupStatus(pool: Pool): Promise<Readonly<Record<string, unknown>>> {
  const row = (
    await pool.query<{
      backup_status: string;
      backup_retention: string | null;
      recovery_expectation: string | null;
      restore_drill_status: string;
      restore_drill_at: Date | null;
    }>(
      'SELECT backup_status,backup_retention,recovery_expectation,restore_drill_status,restore_drill_at FROM operational_recovery_status WHERE singleton',
    )
  ).rows[0];
  if (row === undefined) throw new Error('RECOVERY_STATUS_ABSENT');
  return {
    backupStatus: row.backup_status,
    backupRetention: row.backup_retention,
    recoveryExpectation: row.recovery_expectation,
    restoreDrillStatus: row.restore_drill_status,
    restoreDrillAt: row.restore_drill_at?.toISOString() ?? null,
    statement:
      row.backup_status === 'undetermined'
        ? 'Provider backup status cannot be determined locally; no recovery claim is made.'
        : 'Provider status is operator-acknowledged; a recovery claim requires a recorded passing restore drill.',
  };
}

export async function acknowledgeBackupStatus(
  pool: Pool,
  input: { readonly retention: string; readonly expectation: string },
): Promise<void> {
  if (input.retention.length < 1 || input.retention.length > 200)
    throw new Error('BACKUP_RETENTION_INVALID');
  if (input.expectation.length < 1 || input.expectation.length > 500)
    throw new Error('RECOVERY_EXPECTATION_INVALID');
  await pool.query(
    `UPDATE operational_recovery_status SET backup_status='operator-acknowledged',
      backup_retention=$1,recovery_expectation=$2,acknowledged_at=statement_timestamp()
      WHERE singleton`,
    [input.retention, input.expectation],
  );
}

export type RestoreCheckStatus = 'passed' | 'failed' | 'undetermined';
export interface RestoreCheckResult {
  readonly status: RestoreCheckStatus;
  readonly detail: string;
}
export interface RestoreDrillChecks {
  migrationChecksums(): Promise<RestoreCheckResult>;
  objectExistenceAndSha256Samples(): Promise<RestoreCheckResult>;
  authorizationIsolation(): Promise<RestoreCheckResult>;
  preview(): Promise<RestoreCheckResult>;
  allowedDownload(): Promise<RestoreCheckResult>;
  deniedDownload(): Promise<RestoreCheckResult>;
  mailSink(): Promise<RestoreCheckResult>;
}
const RESTORE_CHECK_NAMES = [
  'migrationChecksums',
  'objectExistenceAndSha256Samples',
  'authorizationIsolation',
  'preview',
  'allowedDownload',
  'deniedDownload',
  'mailSink',
] as const;

/** Local CLI checks never manufacture provider evidence. Checks requiring an
 * object provider, running web service, or mail sink are explicitly
 * undetermined until a deployment-qualified runner is supplied. */
export function localRestoreDrillChecks(
  pool: Pool,
  migrations: readonly { readonly id: string; readonly path: string }[] = generatedMigrations,
): RestoreDrillChecks {
  const undetermined = (detail: string) => (): Promise<RestoreCheckResult> =>
    Promise.resolve({ status: 'undetermined', detail });
  return {
    async migrationChecksums() {
      /*
       * Counting ledger rows proved nothing: a corrupt, partial, reordered, or
       * foreign ledger counted as passed, which is exactly the false restore
       * evidence this drill exists to prevent. Compare every installed id and
       * checksum against the composed registry using the same SHA-256 the
       * migrator pins with, and fail on any missing, extra, reordered, or
       * mismatched entry.
       */
      const applied = (
        await pool.query<{ id: string; checksum: string }>(
          'SELECT id, checksum FROM duefold_migration ORDER BY id',
        )
      ).rows;
      const expected = [...migrations].sort((left, right) => left.id.localeCompare(right.id));
      if (applied.length !== expected.length)
        return {
          status: 'failed',
          detail: `installed ledger has ${String(applied.length)} migrations, registry has ${String(expected.length)}`,
        };
      for (const [index, row] of applied.entries()) {
        const candidate = expected[index];
        if (candidate?.id !== row.id)
          return {
            status: 'failed',
            detail: `migration order or identity diverges at position ${String(index)}: ${row.id}`,
          };
        const checksum = createHash('sha256')
          .update(await readFile(candidate.path, 'utf8'))
          .digest('hex');
        if (checksum !== row.checksum.trim())
          return { status: 'failed', detail: `migration checksum mismatch: ${row.id}` };
      }
      return {
        status: 'passed',
        detail: `all ${String(applied.length)} migration checksums match the composed registry`,
      };
    },
    objectExistenceAndSha256Samples: undetermined('object provider probe unavailable'),
    async authorizationIsolation() {
      const rows = await pool.query<{ isolated: boolean }>(
        `SELECT NOT has_table_privilege('duefold_runtime','session','INSERT')
          AND NOT has_table_privilege('duefold_runtime','document_version','SELECT')
          AND NOT has_table_privilege('duefold_runtime','document_derivative','SELECT') isolated`,
      );
      return rows.rows[0]?.isolated === true
        ? { status: 'passed', detail: 'critical database role isolation checks passed' }
        : { status: 'failed', detail: 'critical database role isolation check failed' };
    },
    preview: undetermined('restored web preview probe unavailable'),
    allowedDownload: undetermined('restored allowed-download probe unavailable'),
    deniedDownload: undetermined('restored denied-download probe unavailable'),
    mailSink: undetermined('deployment mail sink probe unavailable'),
  };
}

export function restoreDrillOutcome(
  results: readonly RestoreCheckResult[],
): 'passed' | 'failed' | 'undetermined' {
  return results.some((result) => result.status === 'failed')
    ? 'failed'
    : results.some((result) => result.status === 'undetermined')
      ? 'undetermined'
      : 'passed';
}

export async function restoreDrill(
  pool: Pool,
  checks: RestoreDrillChecks = localRestoreDrillChecks(pool),
): Promise<{
  readonly status: 'passed' | 'failed' | 'undetermined';
  readonly checks: Readonly<Record<string, RestoreCheckResult>>;
}> {
  const results: Record<string, RestoreCheckResult> = {};
  for (const name of RESTORE_CHECK_NAMES) results[name] = await checks[name]();
  const values = Object.values(results);
  const status = restoreDrillOutcome(values);
  const recorded = status === 'undetermined' ? 'failed' : status;
  await pool.query('SELECT record_restore_drill_result($1,$2,$3,$4)', [
    recorded,
    JSON.stringify({ outcome: status, checks: results }).slice(0, 500),
    createOpaqueId(),
    createCorrelationId(),
  ]);
  if (status !== 'passed') throw new Error(`RESTORE_DRILL_${status.toUpperCase()}`);
  return { status, checks: results };
}

export interface DeletionMarkerStorage {
  getObjectBytes(key: string): Promise<Uint8Array>;
}
export async function reconcileDeletionMarker(
  pool: Pool,
  storage: DeletionMarkerStorage,
  purgeId: string,
): Promise<void> {
  if (!/^[A-Za-z0-9_-]{32}$/u.test(purgeId)) throw new Error('PURGE_ID_INVALID');
  const selected = (
    await pool.query<{ marker_key: string; room_id: string }>(
      'SELECT marker_key,room_id FROM unreconciled_deletion_markers() WHERE purge_id=$1',
      [purgeId],
    )
  ).rows[0];
  if (selected === undefined) throw new Error('DELETION_MARKER_NOT_RECONCILABLE');
  let marker: unknown;
  try {
    marker = JSON.parse(
      Buffer.from(await storage.getObjectBytes(selected.marker_key)).toString('utf8'),
    );
  } catch (error) {
    throw new Error('DELETION_MARKER_UNVERIFIED', { cause: error });
  }
  if (
    typeof marker !== 'object' ||
    marker === null ||
    Array.isArray(marker) ||
    (marker as Record<string, unknown>)['version'] !== 1 ||
    (marker as Record<string, unknown>)['purgeId'] !== purgeId ||
    (marker as Record<string, unknown>)['roomId'] !== selected.room_id
  )
    throw new Error('DELETION_MARKER_MISMATCH');
  const result = await pool.query<{ reconciled: boolean }>(
    'SELECT reconcile_deletion_marker($1,$2,$3,$4) reconciled',
    [purgeId, selected.marker_key, createOpaqueId(), createCorrelationId()],
  );
  if (result.rows[0]?.reconciled !== true) throw new Error('DELETION_MARKER_NOT_RECONCILABLE');
}

export async function assertExternalEnablementAllowed(pool: Pool): Promise<void> {
  const marker = await pool.query(
    'SELECT purge_id FROM unreconciled_deletion_markers() LIMIT 1',
  );
  if (marker.rowCount !== 0) throw new Error('EXTERNAL_ENABLEMENT_REFUSED_DELETION_MARKERS');
}

export function deploymentPlan(
  kind: 'upgrade' | 'rollback',
  target: string,
): Readonly<Record<string, unknown>> {
  if (!/^sha256:[a-f0-9]{64}$/u.test(target)) throw new Error('TARGET_DIGEST_INVALID');
  return {
    action: kind,
    targetImageDigest: target,
    operatorInitiated: true,
    steps:
      kind === 'upgrade'
        ? [
            'record backup status',
            'run restore drill',
            'apply migrations',
            'replace pinned image',
            'run production preflight',
          ]
        : [
            'stop external access',
            'restore tested database snapshot',
            'restore matching object-store version',
            'pin prior image digest',
            'run restore drill before enablement',
          ],
    claim:
      'This is an operator plan, not evidence that an upgrade, rollback, or recovery succeeded.',
  };
}
