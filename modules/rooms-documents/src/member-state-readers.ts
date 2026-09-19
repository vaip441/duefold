import type { Pool } from 'pg';
import type { MemberIdentity } from '../../core-security/src/authorization.ts';

export interface ProcessingState {
  readonly documentId: string;
  readonly versionId: string;
  readonly displayTitle: string;
  readonly state: string;
  readonly failureKind: string | null;
  readonly failureCode: string | null;
  readonly manualRetryCount: number;
  readonly retainedUntil: string | null;
  readonly createdAt: string;
}
interface ProcessingRow {
  readonly document_id: string;
  readonly version_id: string;
  readonly display_title: string;
  readonly state: string;
  readonly failure_kind: string | null;
  readonly failure_code: string | null;
  readonly manual_retry_count: number;
  readonly retained_until: Date | null;
  readonly created_at: Date;
}
export async function readProcessingState(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
  readonly afterCreatedAt: string | null;
  readonly afterVersionId: string | null;
  readonly limit: number;
}): Promise<readonly ProcessingState[]> {
  const result = await input.pool.query<ProcessingRow>(
    'SELECT * FROM read_member_processing_state($1,$2,$3,$4,$5)',
    [input.identity.id, input.roomId, input.afterCreatedAt, input.afterVersionId, input.limit],
  );
  return result.rows.map((row) => ({
    documentId: row.document_id,
    versionId: row.version_id,
    displayTitle: row.display_title,
    state: row.state,
    failureKind: row.failure_kind,
    failureCode: row.failure_code,
    manualRetryCount: row.manual_retry_count,
    retainedUntil: row.retained_until?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  }));
}
