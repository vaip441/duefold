import { MAX_DIRECTORY_TOTAL_BYTES, MAX_MULTIPART_PART_BYTES } from '../resource-policy.ts';
import { createHash } from 'node:crypto';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
  type CompletedPart,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface StorageCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}
const WEB_CREDENTIAL_ROLE: unique symbol = Symbol('duefold.web-storage-credential');
const WORKER_CREDENTIAL_ROLE: unique symbol = Symbol('duefold.worker-storage-credential');
const WEB_CONFIG_ROLE: unique symbol = Symbol('duefold.web-storage-config');
const WORKER_CONFIG_ROLE: unique symbol = Symbol('duefold.worker-storage-config');
export interface StorageConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly credentials: StorageCredentials;
  readonly pathStyle: boolean;
  readonly checksumSupport: boolean;
}
export interface WebStorageCredentials extends StorageCredentials {
  readonly [WEB_CREDENTIAL_ROLE]: true;
}
export interface WorkerStorageCredentials extends StorageCredentials {
  readonly [WORKER_CREDENTIAL_ROLE]: true;
}
export interface WebStorageConfig extends Omit<StorageConfig, 'credentials'> {
  readonly credentials: WebStorageCredentials;
  readonly [WEB_CONFIG_ROLE]: true;
}
export interface WorkerStorageConfig extends Omit<StorageConfig, 'credentials'> {
  readonly credentials: WorkerStorageCredentials;
  readonly [WORKER_CONFIG_ROLE]: true;
}
export function webStorageConfig(config: StorageConfig): WebStorageConfig {
  return {
    ...config,
    credentials: { ...config.credentials, [WEB_CREDENTIAL_ROLE]: true },
    [WEB_CONFIG_ROLE]: true,
  };
}
export function workerStorageConfig(config: StorageConfig): WorkerStorageConfig {
  return {
    ...config,
    credentials: { ...config.credentials, [WORKER_CREDENTIAL_ROLE]: true },
    [WORKER_CONFIG_ROLE]: true,
  };
}
export interface MultipartIdentity {
  readonly key: string;
  readonly uploadId: string;
}
export interface CompletedUploadPart {
  readonly partNumber: number;
  readonly etag: string;
  readonly checksumSha256?: string;
}
export interface StoredObjectMetadata {
  readonly size: number;
  readonly contentType: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly checksumSha256?: string;
}
export interface WebStorage {
  readonly checksumSupport: boolean;
  checkReady(): Promise<void>;
  createMultipart(input: {
    readonly key: string;
    readonly contentType: string;
    readonly metadata: Readonly<Record<string, string>>;
  }): Promise<MultipartIdentity>;
  presignPart(
    input: MultipartIdentity & {
      readonly partNumber: number;
      readonly checksumSha256?: string;
      readonly expiresInSeconds: number;
    },
  ): Promise<string>;
  completeMultipart(
    input: MultipartIdentity & {
      readonly parts: readonly CompletedUploadPart[];
    },
  ): Promise<void>;
  abortMultipart(input: MultipartIdentity): Promise<void>;
  headObject(key: string): Promise<StoredObjectMetadata>;
  deleteObject(key: string): Promise<void>;
}
export interface DeliveryStorage {
  /** Small protected derivatives may be materialized for credential-free
   * watermark composition. Originals use streamObjectRange below. */
  getObjectBytes(
    key: string,
    range?: { readonly start: number; readonly endInclusive: number },
  ): Promise<Uint8Array>;
  streamObjectRange(
    key: string,
    range: { readonly start: number; readonly endInclusive: number },
  ): Promise<AsyncIterable<Uint8Array>>;
  putWatermark(input: {
    readonly key: string;
    readonly bytes: Uint8Array;
    readonly contentType: 'image/png' | 'image/webp';
  }): Promise<void>;
  putExport(input: {
    readonly key: string;
    readonly bytes: Uint8Array;
    readonly contentType: 'application/json' | 'application/zip';
  }): Promise<void>;
  deleteObject(key: string): Promise<void>;
}
export interface WorkerStorage extends WebStorage {
  getObjectBytes(key: string): Promise<Uint8Array>;
  streamObject(key: string): Promise<AsyncIterable<Uint8Array>>;
  putBrandingAsset(input: { readonly key: string; readonly bytes: Uint8Array }): Promise<void>;
  putExportStream(input: {
    readonly key: string;
    readonly stream: AsyncIterable<Uint8Array>;
    readonly contentType: 'application/json' | 'application/zip';
  }): Promise<number>;
  putSystemDeletionMarker(input: {
    readonly key: string;
    readonly bytes: Uint8Array;
  }): Promise<void>;
  putDerivative(input: {
    readonly key: string;
    readonly bytes: Uint8Array;
    readonly contentType: 'image/png' | 'image/webp';
    readonly sha256Base64: string;
  }): Promise<void>;
}

function endpointUrl(raw: string): URL {
  const endpoint = new URL(raw);
  const loopback =
    endpoint.hostname === 'localhost' ||
    endpoint.hostname === '127.0.0.1' ||
    endpoint.hostname === '::1' ||
    endpoint.hostname === '[::1]';
  if (endpoint.protocol !== 'https:' && !(loopback && endpoint.protocol === 'http:'))
    throw new Error('STORAGE_TLS_REQUIRED');
  return endpoint;
}
function positiveInteger(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(code);
}
function metadataRecord(
  value: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  return value ?? {};
}
function createClient(config: StorageConfig): S3Client {
  endpointUrl(config.endpoint);
  if (config.region === '' || config.bucket === '') throw new Error('STORAGE_CONFIG_INVALID');
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.pathStyle,
    credentials: config.credentials,
  });
}

/** One S3-compatible implementation. Capability interfaces, not provider forks,
 * enforce that the web credential cannot read quarantine bytes. */
export function createWebStorage(config: WebStorageConfig): WebStorage {
  const client = createClient(config);
  return {
    checksumSupport: config.checksumSupport,
    async checkReady(): Promise<void> {
      await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
    },
    async createMultipart(input): Promise<MultipartIdentity> {
      const result = await client.send(
        new CreateMultipartUploadCommand({
          Bucket: config.bucket,
          Key: input.key,
          ContentType: input.contentType,
          Metadata: input.metadata,
          ...(config.checksumSupport ? { ChecksumAlgorithm: 'SHA256' } : {}),
        }),
      );
      if (result.UploadId === undefined) throw new Error('STORAGE_CREATE_MULTIPART_FAILED');
      return { key: input.key, uploadId: result.UploadId };
    },
    async presignPart(input): Promise<string> {
      positiveInteger(input.partNumber, 'STORAGE_PART_INVALID');
      if (
        !Number.isSafeInteger(input.expiresInSeconds) ||
        input.expiresInSeconds < 1 ||
        input.expiresInSeconds > 900
      )
        throw new Error('STORAGE_PRESIGN_EXPIRY_INVALID');
      return getSignedUrl(
        client,
        new UploadPartCommand({
          Bucket: config.bucket,
          Key: input.key,
          UploadId: input.uploadId,
          PartNumber: input.partNumber,
          ...(config.checksumSupport ? { ChecksumSHA256: input.checksumSha256 } : {}),
        }),
        { expiresIn: input.expiresInSeconds },
      );
    },
    async completeMultipart(input): Promise<void> {
      if (input.parts.length < 1) throw new Error('STORAGE_PARTS_REQUIRED');
      const parts: CompletedPart[] = input.parts.map((part) => ({
        PartNumber: part.partNumber,
        ETag: part.etag,
        ...(config.checksumSupport ? { ChecksumSHA256: part.checksumSha256 } : {}),
      }));
      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: config.bucket,
          Key: input.key,
          UploadId: input.uploadId,
          MultipartUpload: { Parts: parts },
        }),
      );
    },
    async abortMultipart(input): Promise<void> {
      try {
        await client.send(
          new AbortMultipartUploadCommand({
            Bucket: config.bucket,
            Key: input.key,
            UploadId: input.uploadId,
          }),
        );
      } catch (error) {
        if (!(error instanceof S3ServiceException && error.name === 'NoSuchUpload'))
          throw error;
      }
    },
    async headObject(key): Promise<StoredObjectMetadata> {
      const result = await client.send(
        new HeadObjectCommand({ Bucket: config.bucket, Key: key }),
      );
      if (result.ContentLength === undefined || result.ContentType === undefined)
        throw new Error('STORAGE_METADATA_INCOMPLETE');
      return {
        size: result.ContentLength,
        contentType: result.ContentType,
        metadata: metadataRecord(result.Metadata),
        ...(result.ChecksumSHA256 === undefined
          ? {}
          : { checksumSha256: result.ChecksumSHA256 }),
      };
    },
    async deleteObject(key): Promise<void> {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    },
  };
}

export function createDeliveryStorage(config: WebStorageConfig): DeliveryStorage {
  const client = createClient(config);
  return {
    async getObjectBytes(key, range): Promise<Uint8Array> {
      if (
        range !== undefined &&
        (!Number.isSafeInteger(range.start) ||
          !Number.isSafeInteger(range.endInclusive) ||
          range.start < 0 ||
          range.endInclusive < range.start)
      )
        throw new Error('STORAGE_RANGE_INVALID');
      const result = await client.send(
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: key,
          ...(range === undefined
            ? {}
            : { Range: `bytes=${String(range.start)}-${String(range.endInclusive)}` }),
        }),
      );
      if (result.Body === undefined) throw new Error('STORAGE_OBJECT_BODY_MISSING');
      return result.Body.transformToByteArray();
    },
    async streamObjectRange(key, range): Promise<AsyncIterable<Uint8Array>> {
      if (
        !Number.isSafeInteger(range.start) ||
        !Number.isSafeInteger(range.endInclusive) ||
        range.start < 0 ||
        range.endInclusive < range.start
      )
        throw new Error('STORAGE_RANGE_INVALID');
      const result = await client.send(
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Range: `bytes=${String(range.start)}-${String(range.endInclusive)}`,
        }),
      );
      if (
        result.Body === undefined ||
        typeof (result.Body as { readonly [Symbol.asyncIterator]?: unknown })[
          Symbol.asyncIterator
        ] !== 'function'
      )
        throw new Error('STORAGE_OBJECT_BODY_MISSING');
      return result.Body as AsyncIterable<Uint8Array>;
    },
    async putWatermark(input): Promise<void> {
      if (!/^watermarks\/[A-Za-z0-9_-]{32}\/[A-Za-z0-9_-]{32}$/u.test(input.key))
        throw new Error('STORAGE_WATERMARK_KEY_INVALID');
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: input.key,
          Body: input.bytes,
          ContentType: input.contentType,
          ServerSideEncryption: 'AES256',
          Metadata: { 'duefold-private-cache': 'watermark' },
          IfNoneMatch: '*',
        }),
      );
    },
    async putExport(input): Promise<void> {
      if (!/^exports\/[A-Za-z0-9_-]{32}\/[A-Za-z0-9_-]{32}$/u.test(input.key))
        throw new Error('STORAGE_EXPORT_KEY_INVALID');
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: input.key,
          Body: input.bytes,
          ContentType: input.contentType,
          ServerSideEncryption: 'AES256',
          Metadata: { 'duefold-private-temporary': 'export' },
          IfNoneMatch: '*',
        }),
      );
    },
    async deleteObject(key): Promise<void> {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    },
  };
}

export function createWorkerStorage(config: WorkerStorageConfig): WorkerStorage {
  const web = createWebStorage({
    ...config,
    credentials: {
      accessKeyId: config.credentials.accessKeyId,
      secretAccessKey: config.credentials.secretAccessKey,
      [WEB_CREDENTIAL_ROLE]: true,
    },
    [WEB_CONFIG_ROLE]: true,
  });
  const client = createClient(config);
  return {
    ...web,
    async streamObject(key): Promise<AsyncIterable<Uint8Array>> {
      const result = await client.send(
        new GetObjectCommand({ Bucket: config.bucket, Key: key }),
      );
      if (
        result.Body === undefined ||
        typeof (result.Body as { readonly [Symbol.asyncIterator]?: unknown })[
          Symbol.asyncIterator
        ] !== 'function'
      )
        throw new Error('STORAGE_OBJECT_BODY_MISSING');
      return result.Body as AsyncIterable<Uint8Array>;
    },
    async putBrandingAsset(input): Promise<void> {
      if (!/^branding\/[A-Za-z0-9_-]{32}\/[A-Za-z0-9_-]{32}\.png$/u.test(input.key))
        throw new Error('STORAGE_BRANDING_KEY_INVALID');
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: input.key,
          Body: input.bytes,
          ContentType: 'image/png',
          ServerSideEncryption: 'AES256',
          Metadata: { 'duefold-sanitized-branding': 'v1' },
          IfNoneMatch: '*',
        }),
      );
    },
    async putExportStream(input): Promise<number> {
      if (!/^exports\/[A-Za-z0-9_-]{32}\/[A-Za-z0-9_-]{32}$/u.test(input.key))
        throw new Error('STORAGE_EXPORT_KEY_INVALID');
      const created = await client.send(
        new CreateMultipartUploadCommand({
          Bucket: config.bucket,
          Key: input.key,
          ContentType: input.contentType,
          ServerSideEncryption: 'AES256',
          Metadata: { 'duefold-private-temporary': 'export' },
        }),
      );
      if (created.UploadId === undefined) throw new Error('STORAGE_CREATE_MULTIPART_FAILED');
      const completed: CompletedPart[] = [];
      let pending = Buffer.alloc(0);
      let total = 0;
      const upload = async (bytes: Buffer): Promise<void> => {
        const partNumber = completed.length + 1;
        const checksum = createHash('sha256').update(bytes).digest('base64');
        const result = await client.send(
          new UploadPartCommand({
            Bucket: config.bucket,
            Key: input.key,
            UploadId: created.UploadId,
            PartNumber: partNumber,
            Body: bytes,
            ChecksumSHA256: checksum,
          }),
        );
        if (result.ETag === undefined) throw new Error('STORAGE_PART_ETAG_MISSING');
        completed.push({ PartNumber: partNumber, ETag: result.ETag, ChecksumSHA256: checksum });
      };
      try {
        for await (const chunk of input.stream) {
          if (chunk.byteLength === 0) continue;
          total += chunk.byteLength;
          if (total > MAX_DIRECTORY_TOTAL_BYTES)
            throw new Error('EXPORT_AGGREGATE_LIMIT_EXCEEDED');
          pending = Buffer.concat([pending, Buffer.from(chunk)]);
          while (pending.byteLength >= MAX_MULTIPART_PART_BYTES) {
            await upload(pending.subarray(0, MAX_MULTIPART_PART_BYTES));
            pending = pending.subarray(MAX_MULTIPART_PART_BYTES);
          }
        }
        if (pending.byteLength > 0) await upload(pending);
        if (completed.length === 0) throw new Error('EXPORT_EMPTY');
        await client.send(
          new CompleteMultipartUploadCommand({
            Bucket: config.bucket,
            Key: input.key,
            UploadId: created.UploadId,
            MultipartUpload: { Parts: completed },
          }),
        );
        return total;
      } catch (error) {
        await client.send(
          new AbortMultipartUploadCommand({
            Bucket: config.bucket,
            Key: input.key,
            UploadId: created.UploadId,
          }),
        );
        throw error;
      }
    },
    async putSystemDeletionMarker(input): Promise<void> {
      if (
        !/^system\/deletion-markers\/v1\/[A-Za-z0-9_-]{32}\/[A-Za-z0-9_-]{32}\.json$/u.test(
          input.key,
        )
      )
        throw new Error('STORAGE_DELETION_MARKER_KEY_INVALID');
      if (input.bytes.byteLength < 2 || input.bytes.byteLength > 4096)
        throw new Error('STORAGE_DELETION_MARKER_SIZE_INVALID');
      const command = new PutObjectCommand({
        Bucket: config.bucket,
        Key: input.key,
        Body: input.bytes,
        ContentType: 'application/json',
        ServerSideEncryption: 'AES256',
        Metadata: { 'duefold-private-system': 'deletion-marker-v1' },
        IfNoneMatch: '*',
      });
      try {
        await client.send(command);
      } catch (error) {
        if (!(error instanceof S3ServiceException && error.$metadata.httpStatusCode === 412))
          throw error;
        /*
         * Marker keys are opaque and database-owned. A 412 means an earlier
         * attempt wrote this exact key and crashed before recording completion;
         * treating that condition as success makes the write idempotent without
         * reading or overwriting provider-versioned marker evidence.
         */
      }
    },
    async getObjectBytes(key): Promise<Uint8Array> {
      const result = await client.send(
        new GetObjectCommand({ Bucket: config.bucket, Key: key }),
      );
      if (result.Body === undefined) throw new Error('STORAGE_OBJECT_BODY_MISSING');
      return result.Body.transformToByteArray();
    },
    async putDerivative(input): Promise<void> {
      if (!/^derivatives\/[A-Za-z0-9_-]{32}\/[A-Za-z0-9_-]{32}$/u.test(input.key))
        throw new Error('STORAGE_DERIVATIVE_KEY_INVALID');
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: input.key,
          Body: input.bytes,
          ContentType: input.contentType,
          ChecksumSHA256: input.sha256Base64,
          Metadata: {
            'duefold-sha256': Buffer.from(input.sha256Base64, 'base64').toString('hex'),
          },
          IfNoneMatch: '*',
        }),
      );
      try {
        const stored = await client.send(
          new GetObjectCommand({ Bucket: config.bucket, Key: input.key }),
        );
        if (stored.Body === undefined) throw new Error('STORAGE_DERIVATIVE_VERIFY_FAILED');
        const actual = Buffer.from(await stored.Body.transformToByteArray());
        if (actual.length !== input.bytes.length || !actual.equals(Buffer.from(input.bytes)))
          throw new Error('STORAGE_DERIVATIVE_VERIFY_FAILED');
      } catch (error) {
        try {
          await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: input.key }));
        } catch {
          // The durable cleanup intent created before this call owns subsequent retries.
        }
        throw error;
      }
    },
  };
}
