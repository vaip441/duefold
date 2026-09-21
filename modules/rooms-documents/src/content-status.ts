/**
 * The content half of the status surface: failed processing, and the recovery record the
 * CLI maintains. Authority is `read_content_status`'s.
 */
import type { Pool } from 'pg';
import type { MemberIdentity } from '../../core-security/src/authorization.ts';

export type BackupStatus = 'undetermined' | 'operator-acknowledged';
export type RestoreDrillStatus = 'not-tested' | 'passed' | 'failed';

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

/* The recovery columns are null where the record is absent; the count never is. */
interface ContentRow {
  readonly failed_processing_count: number;
  readonly backup_status: BackupStatus | null;
  readonly backup_retention: string | null;
  readonly recovery_expectation: string | null;
  readonly acknowledged_at: Date | null;
  readonly restore_drill_status: RestoreDrillStatus | null;
  readonly restore_drill_at: Date | null;
}

export async function readContentStatus(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
}): Promise<ContentStatus> {
  const row = (
    await input.pool.query<ContentRow>('SELECT * FROM read_content_status($1)', [
      input.identity.id,
    ])
  ).rows[0];
  if (row === undefined) throw new Error('CONTENT_STATUS_UNAVAILABLE');
  return {
    processing: { failedCount: row.failed_processing_count },
    recovery: {
      /* No record is not a claim of safety: it reads exactly as never having been recorded. */
      backupStatus: row.backup_status ?? 'undetermined',
      backupRetention: row.backup_retention,
      recoveryExpectation: row.recovery_expectation,
      acknowledgedAt: row.acknowledged_at?.toISOString() ?? null,
      restoreDrillStatus: row.restore_drill_status ?? 'not-tested',
      restoreDrillAt: row.restore_drill_at?.toISOString() ?? null,
    },
  };
}
