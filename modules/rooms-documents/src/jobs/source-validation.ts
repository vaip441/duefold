import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import type { JobContext, LeasedJob } from '../../../../apps/worker/src/runner.ts';
import type { ClamAvClient } from '../scanning/clamav.ts';
import { processSource, type ProcessorPrograms } from '../processing/formats.ts';
import type { SandboxIsolation } from '../processing/preflight.ts';
import { assertFormatEnabled } from '../release-policy.ts';
import { validateSourceBytes, type SourceMediaType } from '../source-validation.ts';
import type { WorkerStorage } from '../storage/s3-compatible.ts';

export interface SourceValidationDependencies {
  readonly pool: Pool;
  readonly storage: WorkerStorage;
  readonly scanner: ClamAvClient;
  readonly processorPrograms: ProcessorPrograms;
  /** Absent means the namespaced boundary. Set only by a deployment that has
   * explicitly acknowledged a host without namespace support. */
  readonly isolation?: SandboxIsolation;
}
function versionId(payload: Readonly<Record<string, unknown>>): string {
  const value = payload['versionId'];
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{32}$/u.test(value))
    throw new Error('INVALID_JOB_PAYLOAD');
  return value;
}
function deterministic(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.startsWith('SOURCE_') || error.message.startsWith('PROCESSOR_'))
  );
}
async function failVersion(input: {
  readonly pool: Pool;
  readonly job: LeasedJob;
  readonly context: JobContext;
  readonly id: string;
  readonly state: 'rejected' | 'malware_quarantined' | 'processing_failed';
  readonly kind: 'deterministic' | 'malware' | 'transient';
  readonly code: string;
  readonly days: 7 | 30;
  readonly cause?: unknown;
}): Promise<void> {
  await input.pool.query(
    'SELECT fail_document_processing($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [
      input.id,
      input.job.id,
      input.context.leaseOwner,
      input.job.lease_token,
      input.state,
      input.kind,
      input.code,
      input.days,
      createOpaqueId(),
      createCorrelationId(),
      createOpaqueId(),
    ],
  );
}

export function createHandler(dependencies: SourceValidationDependencies) {
  return async (job: LeasedJob, context: JobContext): Promise<void> => {
    const id = versionId(job.payload);
    const selected = await dependencies.pool.query<{
      object_key: string;
      declared_media_type: string;
      size_bytes: string;
      state: string;
    }>(
      'SELECT object_key,declared_media_type,size_bytes,state FROM document_version WHERE id = $1',
      [id],
    );
    const version = selected.rows[0];
    if (version?.state !== 'quarantine') {
      await context.assertLease();
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = await dependencies.storage.getObjectBytes(version.object_key);
    } catch (error) {
      if (job.attempts >= job.max_attempts)
        await failVersion({
          pool: dependencies.pool,
          job,
          context,
          id,
          state: 'processing_failed',
          kind: 'transient',
          code: 'SOURCE_STORAGE_UNAVAILABLE',
          days: 7,
          cause: error,
        });
      else throw error;
      return;
    }
    let scan;
    try {
      scan = await dependencies.scanner.scan(bytes);
    } catch (error) {
      if (job.attempts >= job.max_attempts)
        await failVersion({
          pool: dependencies.pool,
          job,
          context,
          id,
          state: 'processing_failed',
          kind: 'transient',
          code: 'SCANNER_UNAVAILABLE',
          days: 7,
          cause: error,
        });
      else throw error;
      return;
    }
    if (scan.result === 'malware') {
      await failVersion({
        pool: dependencies.pool,
        job,
        context,
        id,
        state: 'malware_quarantined',
        kind: 'malware',
        code: 'MALWARE_DETECTED',
        days: 30,
      });
      return;
    }
    await dependencies.pool.query('SELECT record_scanner_observation($1,$2,$3,$4,$5,$6)', [
      id,
      job.id,
      context.leaseOwner,
      job.lease_token,
      scan.signatureVersion,
      scan.signatureDate,
    ]);
    await dependencies.pool.query('SELECT record_clean_scan($1,$2,$3,$4,$5,$6,$7,$8)', [
      id,
      job.id,
      context.leaseOwner,
      job.lease_token,
      scan.signatureVersion,
      scan.signatureDate,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    let validated;
    try {
      validated = validateSourceBytes(bytes, version.declared_media_type);
      assertFormatEnabled(validated.mediaType);
    } catch (error) {
      if (!deterministic(error)) {
        if (job.attempts >= job.max_attempts)
          await failVersion({
            pool: dependencies.pool,
            job,
            context,
            id,
            state: 'processing_failed',
            kind: 'transient',
            code: 'FORMAT_POLICY_UNAVAILABLE',
            days: 7,
            cause: error,
          });
        else throw error;
      } else
        await failVersion({
          pool: dependencies.pool,
          job,
          context,
          id,
          state: 'rejected',
          kind: 'deterministic',
          code: 'SOURCE_REJECTED',
          days: 7,
          cause: error,
        });
      return;
    }
    if (validated.size !== Number(version.size_bytes)) {
      await failVersion({
        pool: dependencies.pool,
        job,
        context,
        id,
        state: 'rejected',
        kind: 'deterministic',
        code: 'SOURCE_SIZE_REJECTED',
        days: 7,
      });
      return;
    }
    let processed;
    try {
      processed = await processSource({
        mediaType: validated.mediaType,
        bytes,
        programs: dependencies.processorPrograms,
        signal: context.signal,
        ...(dependencies.isolation === undefined ? {} : { isolation: dependencies.isolation }),
      });
    } catch (error) {
      if (deterministic(error))
        await failVersion({
          pool: dependencies.pool,
          job,
          context,
          id,
          state: 'rejected',
          kind: 'deterministic',
          code: 'PROCESSING_REJECTED',
          days: 7,
          cause: error,
        });
      else if (job.attempts >= job.max_attempts)
        await failVersion({
          pool: dependencies.pool,
          job,
          context,
          id,
          state: 'processing_failed',
          kind: 'transient',
          code: 'PROCESSOR_UNAVAILABLE',
          days: 7,
          cause: error,
        });
      else throw error;
      return;
    }
    const derivatives: {
      id: string;
      page: number;
      key: string;
      mediaType: 'image/png' | 'image/webp';
      size: number;
      sha256: string;
      width: number;
      height: number;
      label: string;
      text: unknown;
    }[] = [];
    try {
      for (const [index, page] of processed.pages.entries()) {
        const derivativeId = createOpaqueId();
        const key = `derivatives/${createOpaqueId()}/${derivativeId}`;
        const digest = createHash('sha256').update(page.image).digest();
        derivatives.push({
          id: derivativeId,
          page: index + 1,
          key,
          mediaType: page.mediaType,
          size: page.image.length,
          sha256: digest.toString('hex'),
          width: page.width,
          height: page.height,
          label: page.accessibleLabel,
          text: page.textLayer ?? null,
        });
        await dependencies.pool.query('SELECT register_derivative_cleanup($1,$2,$3,$4,$5,$6)', [
          id,
          key,
          createOpaqueId(),
          job.id,
          context.leaseOwner,
          job.lease_token,
        ]);
        await dependencies.storage.putDerivative({
          key,
          bytes: page.image,
          contentType: page.mediaType,
          sha256Base64: digest.toString('base64'),
        });
        await dependencies.pool.query(
          'SELECT record_verified_derivative($1,$2,$3,$4,$5,$6,$7)',
          [
            id,
            job.id,
            context.leaseOwner,
            job.lease_token,
            key,
            page.image.length,
            digest.toString('hex'),
          ],
        );
      }
    } catch (error) {
      await Promise.allSettled(
        derivatives.map(({ key }) => dependencies.storage.deleteObject(key)),
      );
      if (job.attempts >= job.max_attempts)
        await failVersion({
          pool: dependencies.pool,
          job,
          context,
          id,
          state: 'processing_failed',
          kind: 'transient',
          code: 'DERIVATIVE_STORAGE_UNAVAILABLE',
          days: 7,
          cause: error,
        });
      else throw error;
      return;
    }
    const client = await dependencies.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT accept_processed_version($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [
          id,
          job.id,
          context.leaseOwner,
          job.lease_token,
          validated.mediaType,
          validated.sha256,
          processed.hiddenSheets.length > 0,
          JSON.stringify(
            derivatives.map((derivative) => ({
              id: derivative.id,
              page_number: derivative.page,
              object_key: derivative.key,
              media_type: derivative.mediaType,
              size_bytes: derivative.size,
              sha256: derivative.sha256,
              width: derivative.width,
              height: derivative.height,
              accessible_label: derivative.label,
              text_layer: derivative.text,
            })),
          ),
          createOpaqueId(),
          createCorrelationId(),
          processed.hiddenSheets.length,
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      await Promise.allSettled(
        derivatives.map(({ key }) => dependencies.storage.deleteObject(key)),
      );
      throw error;
    } finally {
      client.release();
    }
  };
}
export const acceptedMediaType = (value: string): value is SourceMediaType => value.length > 0;
