import type { Pool } from 'pg';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import type { MemberIdentity } from '../../core-security/src/authorization.ts';
import { assertFormatEnabled } from './release-policy.ts';
import type { SourceMediaType } from './source-validation.ts';

export async function requestManualProcessingRetry(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly versionId: string;
}): Promise<void> {
  if (!/^[A-Za-z0-9_-]{32}$/u.test(input.versionId)) throw new Error('INVALID_RETRY_REQUEST');
  const client = await input.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<{
      room_id: string;
      declared_media_type: SourceMediaType;
    }>('SELECT room_id,declared_media_type FROM read_retryable_version($1,$2)', [
      input.versionId,
      input.identity.id,
    ]);
    const version = result.rows[0];
    if (version === undefined) throw new Error('MANUAL_RETRY_FORBIDDEN');
    assertFormatEnabled(version.declared_media_type);
    await client.query('SELECT request_document_processing_retry($1,$2,$3,$4,$5,$6)', [
      input.versionId,
      createOpaqueId(),
      createOpaqueId(),
      input.identity.id,
      version.room_id,
      createCorrelationId(),
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
