import { afterAll, beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  createWebStorage,
  createWorkerStorage,
  webStorageConfig,
  workerStorageConfig,
  type WebStorageConfig,
  type WorkerStorageConfig,
} from '../src/storage/s3-compatible.ts';
import { startS3TestEndpoint, type S3TestEndpoint } from '../../../test/support/s3-endpoint.ts';

let endpoint: S3TestEndpoint;
beforeAll(async () => {
  endpoint = await startS3TestEndpoint();
});
afterAll(async () => endpoint.close());
function config() {
  return {
    endpoint: endpoint.endpoint,
    region: 'us-east-1',
    bucket: endpoint.bucket,
    credentials: {
      accessKeyId: endpoint.accessKeyId,
      secretAccessKey: endpoint.secretAccessKey,
    },
    pathStyle: true,
    checksumSupport: false,
  } as const;
}

describe('S3-compatible signed multipart boundary', () => {
  it('uses real signing and limits each URL to method, part number, and expiry', async () => {
    const storage = createWebStorage(webStorageConfig(config()));
    const identity = await storage.createMultipart({
      key: 'quarantine/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      contentType: 'text/plain',
      metadata: { 'duefold-intent': 'cccccccccccccccccccccccccccccccc' },
    });
    const url = await storage.presignPart({ ...identity, partNumber: 1, expiresInSeconds: 10 });
    expect((await fetch(url, { method: 'PUT', body: 'hello' })).status).toBe(200);
    const otherPart = new URL(url);
    otherPart.searchParams.set('partNumber', '2');
    expect((await fetch(otherPart, { method: 'PUT', body: 'hello' })).status).toBe(403);
    const unsignedHead = new URL(url);
    unsignedHead.search = '';
    expect((await fetch(unsignedHead, { method: 'HEAD' })).status).toBe(403);
    expect((await fetch(url)).status).toBe(403);
    const unsigned = new URL(url);
    unsigned.search = '';
    expect((await fetch(unsigned, { method: 'PUT', body: 'hello' })).status).toBe(403);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 11_000);
      expect((await fetch(url, { method: 'PUT', body: 'hello' })).status).toBe(403);
    } finally {
      vi.useRealTimers();
    }
  });

  it('completes, heads, reads only through worker capability, and deletes', async () => {
    const webConfig = webStorageConfig(config());
    const workerConfig = workerStorageConfig(config());
    const web = createWebStorage(webConfig);
    const worker = createWorkerStorage(workerConfig);
    expectTypeOf(webConfig).not.toExtend<WorkerStorageConfig>();
    expectTypeOf(workerConfig).not.toExtend<WebStorageConfig>();
    const identity = await web.createMultipart({
      key: 'quarantine/dddddddddddddddddddddddddddddddd/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      contentType: 'text/plain',
      metadata: { 'duefold-intent': 'ffffffffffffffffffffffffffffffff' },
    });
    const url = await web.presignPart({ ...identity, partNumber: 1, expiresInSeconds: 60 });
    const uploaded = await fetch(url, { method: 'PUT', body: 'duefold' });
    const etag = uploaded.headers.get('etag');
    if (etag === null) throw new Error('etag missing');
    await web.completeMultipart({ ...identity, parts: [{ partNumber: 1, etag }] });
    await expect(web.headObject(identity.key)).resolves.toMatchObject({
      size: 7,
      contentType: 'text/plain',
      metadata: { 'duefold-intent': 'ffffffffffffffffffffffffffffffff' },
    });
    await expect(worker.getObjectBytes(identity.key)).resolves.toEqual(
      Uint8Array.from(Buffer.from('duefold')),
    );
    await worker.deleteObject(identity.key);
    await expect(web.headObject(identity.key)).rejects.toThrow();
  });

  it('rejects cleartext remote credential endpoints', () => {
    expect(() =>
      createWebStorage(webStorageConfig({ ...config(), endpoint: 'http://storage.example' })),
    ).toThrow('STORAGE_TLS_REQUIRED');
  });
});
