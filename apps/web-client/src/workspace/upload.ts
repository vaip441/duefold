/**
 * The upload transfer itself: intent, part PUTs with progress, finalize.
 *
 * Kept out of the component so the sequencing is testable and so the component
 * holds no transfer logic. Three points of care:
 *
 * 1. `XMLHttpRequest` is used for part PUTs because `fetch` cannot report upload
 *    progress. Progress is bytes the provider acknowledged, never a timer.
 * 2. Parts are uploaded SEQUENTIALLY. Parallel PUTs would make progress
 *    non-monotonic and, for a large file on a slow link, compete for the same
 *    bandwidth while making a stall harder to see.
 * 3. Abort is honoured between and during parts, and a cancelled transfer
 *    finalizes nothing, so the server reaps the abandoned intent rather than
 *    assembling a partial object.
 */

import { ApiError } from '../api/client.ts';

export interface UploadIntent {
  readonly intentId: string;
  readonly uploadId: string;
  readonly parts: readonly { readonly partNumber: number; readonly url: string }[];
}

export interface UploadPartPlan {
  readonly partNumber: number;
  readonly size: number;
  readonly checksumSha256?: string;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('aborted', 'AbortError');
}

/** Hashes each exact multipart slice before requesting checksum-bound upload URLs. */
export async function checksumPartPlan(input: {
  readonly file: File;
  readonly plan: readonly UploadPartPlan[];
  readonly signal: AbortSignal;
}): Promise<readonly UploadPartPlan[]> {
  const checksummed: UploadPartPlan[] = [];
  let offset = 0;
  for (const part of input.plan) {
    throwIfAborted(input.signal);
    const bytes = await input.file.slice(offset, offset + part.size).arrayBuffer();
    throwIfAborted(input.signal);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    checksummed.push({
      ...part,
      checksumSha256: base64(new Uint8Array(digest)),
    });
    offset += part.size;
  }
  return checksummed;
}

export interface CompletedUploadPart {
  readonly partNumber: number;
  readonly etag: string;
  readonly checksumSha256?: string;
}

/** One part PUT with progress. Resolves the provider's ETag. */
export function putPart(input: {
  readonly url: string;
  readonly body: Blob;
  readonly signal: AbortSignal;
  readonly onProgress: (bytes: number) => void;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', input.url, true);
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) input.onProgress(event.loaded);
    });
    request.addEventListener('load', () => {
      if (request.status < 200 || request.status >= 300) {
        reject(new ApiError('unavailable'));
        return;
      }
      const etag = request.getResponseHeader('etag');
      if (etag === null || etag === '') {
        reject(new ApiError('unavailable'));
        return;
      }
      resolve(etag);
    });
    request.addEventListener('error', () => {
      reject(new ApiError('offline'));
    });
    request.addEventListener('abort', () => {
      reject(new DOMException('aborted', 'AbortError'));
    });
    input.signal.addEventListener(
      'abort',
      () => {
        request.abort();
      },
      { once: true },
    );
    request.send(input.body);
  });
}

/**
 * Uploads every part in order, reporting aggregate progress.
 *
 * Progress is computed from completed parts plus the in-flight part's own loaded
 * count, so it advances monotonically and cannot jump backwards when a part
 * restarts its progress events.
 */
export async function transferParts(input: {
  readonly file: File;
  readonly intent: UploadIntent;
  readonly plan: readonly UploadPartPlan[];
  readonly signal: AbortSignal;
  readonly onProgress: (percent: number) => void;
}): Promise<readonly CompletedUploadPart[]> {
  const total = input.plan.reduce((sum, part) => sum + part.size, 0);
  const completed: CompletedUploadPart[] = [];
  let settledBytes = 0;
  let offset = 0;
  for (const part of input.plan) {
    if (input.signal.aborted) throw new DOMException('aborted', 'AbortError');
    const url = input.intent.parts.find(
      (candidate) => candidate.partNumber === part.partNumber,
    )?.url;
    if (url === undefined) throw new ApiError('unavailable');
    const slice = input.file.slice(offset, offset + part.size);
    const etag = await putPart({
      url,
      body: slice,
      signal: input.signal,
      onProgress: (bytes) => {
        const percent = total === 0 ? 0 : Math.round(((settledBytes + bytes) / total) * 100);
        input.onProgress(Math.min(100, Math.max(0, percent)));
      },
    });
    completed.push({
      partNumber: part.partNumber,
      etag,
      ...(part.checksumSha256 === undefined ? {} : { checksumSha256: part.checksumSha256 }),
    });
    settledBytes += part.size;
    offset += part.size;
    input.onProgress(total === 0 ? 100 : Math.round((settledBytes / total) * 100));
  }
  return completed;
}
