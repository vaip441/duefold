import {
  afterAll,
  beforeAll,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import {
  S3Client,
  type DeleteObjectsCommand,
  type DeleteObjectsCommandOutput,
  type ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
} from '@aws-sdk/client-s3';
import {
  DELETE_OBJECTS_BATCH_KEYS,
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

describe('batch deletion', () => {
  it('deletes a whole batch in one request and fails when any key is reported undeleted', async () => {
    const web = createWebStorage(webStorageConfig(config()));
    const worker = createWorkerStorage(workerStorageConfig(config()));
    const key = (room: string) => `branding/${room.repeat(32)}/${'d'.repeat(32)}.png`;
    const stored = [key('a'), key('b')];
    for (const storedKey of stored)
      await worker.putBrandingAsset({ key: storedKey, bytes: Uint8Array.of(1) });
    const send = vi.spyOn(S3Client.prototype, 'send') as unknown as MockInstance<
      (command: DeleteObjectsCommand) => Promise<DeleteObjectsCommandOutput>
    >;
    try {
      await worker.deleteObjects([...stored, key('c')]);
      expect(send).toHaveBeenCalledTimes(1);
      for (const storedKey of stored) await expect(web.headObject(storedKey)).rejects.toThrow();
      send.mockResolvedValue({
        $metadata: {},
        Errors: [{ Key: key('a'), Code: 'AccessDenied', Message: 'Access Denied' }],
      });
      await expect(worker.deleteObjects([key('a'), key('b')])).rejects.toThrow(
        'STORAGE_DELETE_FAILED',
      );
    } finally {
      send.mockRestore();
    }
    await expect(worker.deleteObjects([])).rejects.toThrow('STORAGE_DELETE_BATCH_INVALID');
    await expect(
      worker.deleteObjects(
        Array.from({ length: DELETE_OBJECTS_BATCH_KEYS + 1 }, () => key('a')),
      ),
    ).rejects.toThrow('STORAGE_DELETE_BATCH_INVALID');
  });
});

describe('deletion marker listing', () => {
  it('names the room of every marker across pages and refuses an unrecognized key', async () => {
    const first = 'a'.repeat(32);
    const second = 'b'.repeat(32);
    const marker = (roomId: string) =>
      `system/deletion-markers/v1/${roomId}/${'c'.repeat(32)}.json`;
    const send = vi.spyOn(S3Client.prototype, 'send') as unknown as MockInstance<
      (command: ListObjectsV2Command) => Promise<ListObjectsV2CommandOutput>
    >;
    try {
      send.mockImplementation((command) =>
        Promise.resolve(
          command.input.ContinuationToken === undefined
            ? {
                $metadata: {},
                Contents: [{ Key: marker(first) }],
                IsTruncated: true,
                NextContinuationToken: 'next',
              }
            : { $metadata: {}, Contents: [{ Key: marker(second) }], IsTruncated: false },
        ),
      );
      const storage = createWorkerStorage(workerStorageConfig(config()));
      await expect(storage.listDeletionMarkedRoomIds()).resolves.toEqual([first, second]);
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[0]?.[0].input).toMatchObject({
        Bucket: endpoint.bucket,
        Prefix: 'system/deletion-markers/v1/',
      });
      send.mockResolvedValue({
        $metadata: {},
        Contents: [{ Key: 'system/deletion-markers/v1/stray.json' }],
      });
      await expect(storage.listDeletionMarkedRoomIds()).rejects.toThrow(
        'STORAGE_DELETION_MARKER_KEY_INVALID',
      );
    } finally {
      send.mockRestore();
    }
  });
});
