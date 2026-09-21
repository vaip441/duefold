/**
 * Status facts a browser journey starts from, written as the migration role the way the
 * worker and the CLI record them.
 */
import type { Pool } from 'pg';

export async function seedStatusObservation(
  pool: Pool,
  observation: {
    readonly check: 'storage-privacy' | 'storage-versioning' | 'scanner' | 'updates';
    readonly result: 'pass' | 'attention' | 'fail';
    readonly code: string;
    readonly evidenceAt?: Date;
    readonly evidenceVersion?: string;
    readonly observedAt?: Date;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO deployment_status_observation
       (check_name,result,code,evidence_at,evidence_version,observed_at)
     VALUES($1,$2,$3,$4,$5,COALESCE($6, statement_timestamp()))
     ON CONFLICT (check_name) DO UPDATE
       SET result=EXCLUDED.result,code=EXCLUDED.code,evidence_at=EXCLUDED.evidence_at,
           evidence_version=EXCLUDED.evidence_version,observed_at=EXCLUDED.observed_at`,
    [
      observation.check,
      observation.result,
      observation.code,
      observation.evidenceAt ?? null,
      observation.evidenceVersion ?? null,
      observation.observedAt ?? null,
    ],
  );
}
