import type { Pool } from 'pg';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import type { MemberIdentity } from '../../core-security/src/authorization.ts';
import type { WebStorage } from './storage/s3-compatible.ts';

export async function deleteFailedSource(input: {
  readonly pool: Pool;
  readonly storage: WebStorage;
  readonly identity: MemberIdentity;
  readonly versionId: string;
}): Promise<void> {
  if (!/^[A-Za-z0-9_-]{32}$/u.test(input.versionId)) throw new Error('INVALID_DELETE_REQUEST');
  let pending: { readonly rows: readonly { readonly object_key: string }[] };
  try {
    pending = await input.pool.query<{ object_key: string }>(
      'SELECT object_key FROM begin_member_failed_source_deletion($1,$2,$3,$4,$5)',
      [
        input.versionId,
        input.identity.id,
        input.identity.globalRole,
        createOpaqueId(),
        createCorrelationId(),
      ],
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'failed source delete forbidden')
      throw new Error('FAILED_SOURCE_DELETE_FORBIDDEN', { cause: error });
    throw error;
  }
  const objectKey = pending.rows[0]?.object_key;
  if (objectKey === undefined) throw new Error('FAILED_SOURCE_DELETE_FORBIDDEN');
  await input.storage.deleteObject(objectKey);
  await input.pool.query('SELECT finalize_member_failed_source_deletion($1,$2,$3,$4,$5)', [
    input.versionId,
    input.identity.id,
    input.identity.globalRole,
    createOpaqueId(),
    createCorrelationId(),
  ]);
}
