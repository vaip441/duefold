import { Type } from '@sinclair/typebox';
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
  readonly cursor_created_at: string;
  readonly continues: boolean;
}
/** `createdAt` is PostgreSQL's own text, because a Date would drop its microseconds. */
export interface ProcessingCursor {
  readonly createdAt: string;
  readonly versionId: string;
}
/* The exact shape of the readers' cursor text, so a malformed value is a 400 at the route
   rather than a failed timestamptz cast in the database. */
export const CURSOR_CREATED_AT = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{6}Z$',
});
export interface ProcessingPage {
  readonly versions: readonly ProcessingState[];
  /** Absent when this page is provably the last one. */
  readonly nextCursor?: ProcessingCursor;
}
export async function readProcessingState(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
  readonly afterCreatedAt: string | null;
  readonly afterVersionId: string | null;
  readonly limit: number;
}): Promise<ProcessingPage> {
  const result = await input.pool.query<ProcessingRow>(
    'SELECT * FROM read_member_processing_state($1,$2,$3,$4,$5)',
    [input.identity.id, input.roomId, input.afterCreatedAt, input.afterVersionId, input.limit],
  );
  const last = result.rows.at(-1);
  const versions = result.rows.map((row) => ({
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
  return {
    versions,
    ...(last?.continues === true
      ? { nextCursor: { createdAt: last.cursor_created_at, versionId: last.version_id } }
      : {}),
  };
}
