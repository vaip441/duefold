import type { Pool } from 'pg';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import type { JobContext, LeasedJob } from '../../../../apps/worker/src/runner.ts';
import type { WebStorage } from '../storage/s3-compatible.ts';

export interface MultipartReapDependencies {
  readonly pool: Pool;
  readonly storage: WebStorage;
}
function intentId(payload: Readonly<Record<string, unknown>>): string {
  const value = payload['intentId'];
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{32}$/u.test(value))
    throw new Error('INVALID_JOB_PAYLOAD');
  return value;
}
export function createHandler(dependencies: MultipartReapDependencies) {
  return async (job: LeasedJob, context: JobContext): Promise<void> => {
    const id = intentId(job.payload);
    const selected = await dependencies.pool.query<{
      object_key: string;
      upload_id: string;
    }>(
      `SELECT u.object_key,u.upload_id FROM upload_intent u JOIN job_queue j ON j.id = $2
       WHERE u.id = $1 AND u.state IN ('open','completing')
         AND u.expires_at <= transaction_timestamp() AND j.state = 'running'
         AND j.lease_owner = $3 AND j.lease_token = $4
         AND j.lease_expires_at > transaction_timestamp()`,
      [id, job.id, context.leaseOwner, job.lease_token],
    );
    const intent = selected.rows[0];
    if (intent === undefined) {
      await context.assertLease();
      return;
    }
    await dependencies.storage.abortMultipart({
      key: intent.object_key,
      uploadId: intent.upload_id,
    });
    const expired = await dependencies.pool.query(
      `WITH changed AS (
         UPDATE upload_intent u SET state = 'expired'
         FROM job_queue j WHERE u.id = $1 AND u.state IN ('open','completing')
           AND u.expires_at <= transaction_timestamp() AND j.id = $2 AND j.state = 'running'
           AND j.lease_owner = $3 AND j.lease_token = $4
           AND j.lease_expires_at > transaction_timestamp() RETURNING u.id
       )
       INSERT INTO audit_event
         (id,event_type,actor_kind,subject_id,resource_type,resource_id,result,reason_code,correlation_id)
       SELECT $5,'upload.expired','system',id,'upload_intent',id,'success','MULTIPART_ABORTED',$6 FROM changed`,
      [
        id,
        job.id,
        context.leaseOwner,
        job.lease_token,
        createOpaqueId(),
        createCorrelationId(),
      ],
    );
    if (expired.rowCount !== 1) throw new Error('JOB_LEASE_LOST');
  };
}
