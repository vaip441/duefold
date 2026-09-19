import { createHmac } from 'node:crypto';
import type { Pool } from 'pg';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import type { JobContext, LeasedJob } from '../../../../apps/worker/src/runner.ts';
import type { WorkerStorage } from '../storage/s3-compatible.ts';

export interface RoomPurgeDependencies {
  readonly pool: Pool;
  readonly storage: WorkerStorage;
  /** Independent base64url key supplied only to the worker process. */
  readonly piiHmacKey: string;
}

function purgeId(payload: Readonly<Record<string, unknown>>): string {
  const value = payload['purgeId'];
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{32}$/u.test(value))
    throw new Error('INVALID_JOB_PAYLOAD');
  return value;
}

function decodeKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64url');
  if (key.byteLength < 32) throw new Error('WEAK_PII_HMAC_KEY');
  return key;
}

export function viewerEvidenceReference(input: {
  readonly key: string;
  readonly roomId: string;
  readonly viewerId: string;
}): string {
  if (
    !/^[A-Za-z0-9_-]{32}$/u.test(input.roomId) ||
    !/^[A-Za-z0-9_-]{32}$/u.test(input.viewerId)
  )
    throw new Error('INVALID_PSEUDONYM_SCOPE');
  const scopeKey = createHmac('sha256', decodeKey(input.key))
    .update(`duefold-viewer-evidence-v1\0room:${input.roomId}`)
    .digest();
  return `vref_${createHmac('sha256', scopeKey).update(input.viewerId).digest('hex')}`;
}

export function createHandler(dependencies: RoomPurgeDependencies) {
  return async (job: LeasedJob, context: JobContext): Promise<void> => {
    const id = purgeId(job.payload);
    const selected = (
      await dependencies.pool.query<{ marker_key: string; room_id: string }>(
        'SELECT * FROM begin_room_purge($1,$2,$3,$4)',
        [id, job.id, context.leaseOwner, job.lease_token],
      )
    ).rows[0];
    if (selected === undefined) throw new Error('ROOM_PURGE_NOT_DUE');
    await context.assertLease();
    await dependencies.storage.putSystemDeletionMarker({
      key: selected.marker_key,
      bytes: Buffer.from(
        JSON.stringify({
          version: 1,
          purgeId: id,
          roomId: selected.room_id,
          recordedAt: new Date().toISOString(),
        }),
        'utf8',
      ),
    });
    const objects = await dependencies.pool.query<{ object_key: string }>(
      'SELECT object_key FROM mark_room_purge_marker_written($1,$2,$3,$4)',
      [id, job.id, context.leaseOwner, job.lease_token],
    );
    const viewers = await dependencies.pool.query<{ viewer_id: string }>(
      'SELECT viewer_id FROM read_room_purge_viewers($1,$2,$3,$4)',
      [id, job.id, context.leaseOwner, job.lease_token],
    );
    for (const object of objects.rows) {
      await context.assertLease();
      await dependencies.storage.deleteObject(object.object_key);
    }
    const pseudonyms = viewers.rows.map(({ viewer_id: viewerId }) => ({
      viewerId,
      reference: viewerEvidenceReference({
        key: dependencies.piiHmacKey,
        roomId: selected.room_id,
        viewerId,
      }),
    }));
    await dependencies.pool.query('SELECT finalize_room_purge($1,$2,$3,$4,$5,$6,$7)', [
      id,
      job.id,
      context.leaseOwner,
      job.lease_token,
      JSON.stringify(pseudonyms),
      createOpaqueId(),
      createCorrelationId(),
    ]);
  };
}
