/**
 * What the worker can observe about the bucket without writing to it.
 *
 * Privacy: two unauthenticated requests to the S3 API — one for a random key, one for a
 * listing — must both be refused. A 404 for the key means the API tells strangers what
 * exists, which is public read. Only the API endpoint is reachable from here: a public URL a
 * provider serves outside it (R2's `r2.dev` domain, a CDN) is invisible to this check, and
 * the status surface says so.
 *
 * Versioning: asked with the worker credential. A provider that does not implement the call,
 * or a credential not permitted to make it, reads as not detectable, never as enabled.
 */
import { GetBucketVersioningCommand, S3ServiceException } from '@aws-sdk/client-s3';
import { createOpaqueId } from '@duefold/shared/ids';
import type {
  StoragePrivacyCode,
  StorageVersioningCode,
} from '../../../core-security/src/status-observations.ts';
import { createStorageClient, type WorkerStorageConfig } from './s3-compatible.ts';

export interface StorageStatusProbe {
  privacy(): Promise<StoragePrivacyCode>;
  versioning(): Promise<StorageVersioningCode>;
}

const PROBE_TIMEOUT_MILLISECONDS = 10_000;
/* Forbidden, method not allowed, not implemented: the question cannot be answered here. */
const UNANSWERABLE = new Set([403, 405, 501]);

export function anonymousAccessCode(
  objectStatus: number,
  listStatus: number,
): StoragePrivacyCode {
  if (listStatus === 200) return 'ANONYMOUS_LIST_ALLOWED';
  if (objectStatus === 200 || objectStatus === 404) return 'ANONYMOUS_READ_ALLOWED';
  const refused = (status: number): boolean => status === 401 || status === 403;
  return refused(objectStatus) && refused(listStatus)
    ? 'ANONYMOUS_ACCESS_REFUSED'
    : 'STORAGE_PROBE_INCONCLUSIVE';
}

export function versioningCode(status: string | undefined): StorageVersioningCode {
  if (status === 'Enabled') return 'VERSIONING_ENABLED';
  if (status === 'Suspended') return 'VERSIONING_SUSPENDED';
  return 'VERSIONING_NEVER_ENABLED';
}

/** The bucket's S3 API address for `key`, addressed the way the adapter is configured. */
export function bucketUrl(
  config: Pick<WorkerStorageConfig, 'endpoint' | 'bucket' | 'pathStyle'>,
  key: string,
): URL {
  const url = new URL(config.endpoint);
  const base = url.pathname.replace(/\/+$/u, '');
  if (config.pathStyle) url.pathname = `${base}/${config.bucket}/${key}`;
  else {
    url.hostname = `${config.bucket}.${url.hostname}`;
    url.pathname = `${base}/${key}`;
  }
  return url;
}

export function createStorageStatusProbe(
  config: WorkerStorageConfig,
  fetchImpl: typeof fetch = fetch,
): StorageStatusProbe {
  const client = createStorageClient(config);
  const anonymousStatus = async (url: URL, method: 'HEAD' | 'GET'): Promise<number> =>
    (
      await fetchImpl(url, {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MILLISECONDS),
      })
    ).status;
  return {
    async privacy() {
      const object = bucketUrl(config, `status-probe/${createOpaqueId()}`);
      const listing = bucketUrl(config, '');
      listing.search = '?list-type=2&max-keys=1';
      try {
        const [objectStatus, listStatus] = await Promise.all([
          anonymousStatus(object, 'HEAD'),
          anonymousStatus(listing, 'GET'),
        ]);
        return anonymousAccessCode(objectStatus, listStatus);
      } catch (error: unknown) {
        /* fetch rejects with a TypeError when the endpoint cannot be reached, and the timeout
           aborts with a TimeoutError. Anything else is a fault, not an answer. */
        if (
          error instanceof TypeError ||
          (error instanceof DOMException && error.name === 'TimeoutError')
        )
          return 'STORAGE_UNREACHABLE';
        throw error;
      }
    },
    async versioning() {
      try {
        const answer = await client.send(
          new GetBucketVersioningCommand({ Bucket: config.bucket }),
          { abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MILLISECONDS) },
        );
        return versioningCode(answer.Status);
      } catch (error: unknown) {
        return error instanceof S3ServiceException &&
          UNANSWERABLE.has(error.$metadata.httpStatusCode ?? 0)
          ? 'VERSIONING_NOT_DETECTABLE'
          : 'STORAGE_UNREACHABLE';
      }
    },
  };
}
