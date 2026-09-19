import type { Pool } from 'pg';
import type { ViewerIdentity } from '../../core-security/src/authorization.ts';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import type { DeliveryStorage } from './storage/s3-compatible.ts';

const MAX_ORIGINAL_BYTES = 262_144_000;
function sessionProof(identity: ViewerIdentity): string {
  if (identity.sessionProof === undefined) throw new Error('VIEWER_SESSION_PROOF_REQUIRED');
  return identity.sessionProof;
}
export interface DownloadLeaseResult {
  readonly leaseId: string;
  readonly versionId: string;
  readonly sizeBytes: number;
  readonly expiresAt: Date;
  readonly filename: string;
  readonly correlationId: string;
}
export async function createDownloadLease(input: {
  readonly pool: Pool;
  readonly identity: ViewerIdentity;
  readonly roomId: string;
  readonly documentId: string;
}): Promise<DownloadLeaseResult> {
  const leaseId = createOpaqueId();
  const correlationId = createCorrelationId();
  const result = await input.pool.query<{
    lease_id: string;
    version_id: string;
    size_bytes: string;
    expires_at: Date;
    filename: string;
  }>('SELECT * FROM create_download_lease($1,$2,$3,$4,$5)', [
    leaseId,
    sessionProof(input.identity),
    input.roomId,
    input.documentId,
    correlationId,
  ]);
  const row = result.rows[0];
  if (row === undefined) throw new Error('DOWNLOAD_UNAVAILABLE');
  const sizeBytes = Number(row.size_bytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_ORIGINAL_BYTES)
    throw new Error('DOWNLOAD_UNAVAILABLE');
  return {
    leaseId: row.lease_id,
    versionId: row.version_id,
    sizeBytes,
    expiresAt: row.expires_at,
    filename: row.filename,
    correlationId,
  };
}

export interface ByteRange {
  readonly start: number;
  readonly endInclusive: number;
}
export function parseSingleRange(value: string | undefined, size: number): ByteRange {
  if (!Number.isSafeInteger(size) || size < 1 || value === undefined)
    throw new Error('RANGE_REQUIRED');
  const match = /^bytes=(0|[1-9][0-9]*)-(0|[1-9][0-9]*)$/u.exec(value);
  if (match === null) throw new Error('RANGE_INVALID');
  const start = Number(match[1]);
  const endInclusive = Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(endInclusive) ||
    start > endInclusive ||
    endInclusive >= size
  )
    throw new Error('RANGE_INVALID');
  return { start, endInclusive };
}

export async function streamDownloadRange(input: {
  readonly pool: Pool;
  readonly storage: DeliveryStorage;
  readonly identity: ViewerIdentity;
  readonly leaseId: string;
  readonly rangeHeader: string;
}): Promise<{
  readonly stream: AsyncIterable<Uint8Array>;
  readonly contentLength: number;
  readonly sizeBytes: number;
  readonly correlationId: string;
}> {
  const authorized = (
    await input.pool.query<{ object_key: string; size_bytes: string; correlation_id: string }>(
      'SELECT * FROM authorize_download_range($1,$2,$3)',
      [input.leaseId, sessionProof(input.identity), createOpaqueId()],
    )
  ).rows[0];
  if (authorized === undefined) throw new Error('DOWNLOAD_UNAVAILABLE');
  const sizeBytes = Number(authorized.size_bytes);
  const range = parseSingleRange(input.rangeHeader, sizeBytes);
  let source: AsyncIterable<Uint8Array>;
  try {
    source = await input.storage.streamObjectRange(authorized.object_key, range);
  } catch (error) {
    await input.pool.query('SELECT fail_download($1,$2,$3)', [
      input.leaseId,
      sessionProof(input.identity),
      createOpaqueId(),
    ]);
    throw error;
  }
  const expected = range.endInclusive - range.start + 1;
  async function* accounted(): AsyncGenerator<Uint8Array> {
    let bytes = 0;
    try {
      for await (const chunk of source) {
        bytes += chunk.length;
        if (bytes > expected) throw new Error('DOWNLOAD_STREAM_LENGTH_MISMATCH');
        yield chunk;
      }
      if (bytes !== expected) throw new Error('DOWNLOAD_STREAM_LENGTH_MISMATCH');
      const recorded = await input.pool.query<{ ok: boolean }>(
        'SELECT record_download_range($1,$2,$3,$4,$5,$6) ok',
        [
          input.leaseId,
          sessionProof(input.identity),
          range.start,
          range.endInclusive + 1,
          bytes,
          createOpaqueId(),
        ],
      );
      if (recorded.rows[0]?.ok !== true) throw new Error('DOWNLOAD_UNAVAILABLE');
    } catch (error) {
      await input.pool.query('SELECT fail_download($1,$2,$3)', [
        input.leaseId,
        sessionProof(input.identity),
        createOpaqueId(),
      ]);
      throw error;
    }
  }
  return {
    stream: accounted(),
    contentLength: expected,
    sizeBytes,
    correlationId: authorized.correlation_id,
  };
}
