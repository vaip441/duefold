import type { Pool } from 'pg';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import type { ClamAvClient } from '../../../rooms-documents/src/scanning/clamav.ts';
import type {
  invokeSandboxed,
  SandboxProgram,
} from '../../../rooms-documents/src/processing/sandbox.ts';
import type { WorkerStorage } from '../../../rooms-documents/src/storage/s3-compatible.ts';
import type { JobContext, LeasedJob } from '../../../../apps/worker/src/runner.ts';
import { processBrandImage } from '../branding.ts';

export interface BrandingImageDependencies {
  readonly pool: Pool;
  readonly storage: WorkerStorage;
  readonly scanner: ClamAvClient;
  readonly processorPrograms: { readonly image: SandboxProgram };
  readonly invokeBrandingSandbox?: typeof invokeSandboxed;
}
function intentId(payload: Readonly<Record<string, unknown>>): string {
  const value = payload['intentId'];
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{32}$/u.test(value))
    throw new Error('INVALID_JOB_PAYLOAD');
  return value;
}
export function createHandler(dependencies: BrandingImageDependencies) {
  return async (job: LeasedJob, context: JobContext): Promise<void> => {
    const id = intentId(job.payload);
    const selected = (
      await dependencies.pool.query<{
        object_key: string;
        declared_media_type: string;
        asset_kind: string;
      }>('SELECT * FROM claim_branding_processing($1,$2,$3,$4)', [
        id,
        job.id,
        context.leaseOwner,
        job.lease_token,
      ])
    ).rows[0];
    if (selected === undefined) throw new Error('BRANDING_PROCESSING_FORBIDDEN');
    const processed = await processBrandImage({
      bytes: await dependencies.storage.getObjectBytes(selected.object_key),
      declaredMediaType: selected.declared_media_type,
      scanner: dependencies.scanner,
      program: dependencies.processorPrograms.image,
      ...(dependencies.invokeBrandingSandbox === undefined
        ? {}
        : { invoke: dependencies.invokeBrandingSandbox }),
    });
    await context.assertLease();
    const outputKey = `branding/${createOpaqueId()}/${createOpaqueId()}.png`;
    await dependencies.storage.putBrandingAsset({ key: outputKey, bytes: processed.bytes });
    const completed = await dependencies.pool.query<{ complete_branding_processing: boolean }>(
      'SELECT complete_branding_processing($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [
        id,
        job.id,
        context.leaseOwner,
        job.lease_token,
        outputKey,
        processed.bytes.byteLength,
        processed.width,
        processed.height,
        createOpaqueId(),
        createCorrelationId(),
      ],
    );
    if (completed.rows[0]?.complete_branding_processing !== true) {
      await dependencies.storage.deleteObject(outputKey);
      throw new Error('BRANDING_PROCESSING_CONFLICT');
    }
    await dependencies.storage.deleteObject(selected.object_key);
  };
}
