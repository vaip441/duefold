import { describe, expect, it } from 'vitest';
import { workerStorageConfig } from './s3-compatible.ts';
import {
  anonymousAccessCode,
  bucketUrl,
  createStorageStatusProbe,
  versioningCode,
} from './status-probe.ts';

const config = workerStorageConfig({
  endpoint: 'https://storage.example',
  region: 'auto',
  bucket: 'duefold',
  credentials: { accessKeyId: 'worker-key', secretAccessKey: 'worker-secret' },
  pathStyle: true,
  checksumSupport: false,
});

describe('anonymousAccessCode', () => {
  it.each([
    [403, 403, 'ANONYMOUS_ACCESS_REFUSED'],
    [401, 403, 'ANONYMOUS_ACCESS_REFUSED'],
    [404, 403, 'ANONYMOUS_READ_ALLOWED'],
    [200, 403, 'ANONYMOUS_READ_ALLOWED'],
    [403, 200, 'ANONYMOUS_LIST_ALLOWED'],
    [403, 500, 'STORAGE_PROBE_INCONCLUSIVE'],
    [301, 403, 'STORAGE_PROBE_INCONCLUSIVE'],
  ] as const)('object %i, listing %i → %s', (objectStatus, listStatus, code) => {
    expect(anonymousAccessCode(objectStatus, listStatus)).toBe(code);
  });
});

describe('versioningCode', () => {
  it('names each state the API can answer, and never reads silence as enabled', () => {
    expect(versioningCode('Enabled')).toBe('VERSIONING_ENABLED');
    expect(versioningCode('Suspended')).toBe('VERSIONING_SUSPENDED');
    expect(versioningCode(undefined)).toBe('VERSIONING_NEVER_ENABLED');
  });
});

describe('bucketUrl', () => {
  it('addresses the bucket the way the adapter is configured', () => {
    expect(bucketUrl(config, 'k').href).toBe('https://storage.example/duefold/k');
    expect(bucketUrl({ ...config, pathStyle: false }, 'k').href).toBe(
      'https://duefold.storage.example/k',
    );
    expect(bucketUrl({ ...config, endpoint: 'https://storage.example/s3/' }, 'k').href).toBe(
      'https://storage.example/s3/duefold/k',
    );
  });
});

describe('the privacy probe', () => {
  function answering(objectStatus: number, listStatus: number) {
    const requests: {
      readonly url: string;
      readonly method: string;
      readonly headers: Headers;
    }[] = [];
    const fetchImpl: typeof fetch = (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requests.push({
        url,
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
      });
      return Promise.resolve(
        new Response(null, { status: url.includes('list-type=2') ? listStatus : objectStatus }),
      );
    };
    return { requests, probe: createStorageStatusProbe(config, fetchImpl) };
  }

  it('asks as a stranger: no credential, one random key and one listing', async () => {
    const { requests, probe } = answering(403, 403);
    expect(await probe.privacy()).toBe('ANONYMOUS_ACCESS_REFUSED');
    expect(requests.map(({ method }) => method).sort()).toStrictEqual(['GET', 'HEAD']);
    expect(requests.every(({ headers }) => !headers.has('authorization'))).toBe(true);
    expect(requests.find(({ method }) => method === 'HEAD')?.url).toMatch(
      /^https:\/\/storage\.example\/duefold\/status-probe\/[A-Za-z0-9_-]{32}$/u,
    );
  });

  it('reports a namespace that answers strangers as public read', async () => {
    expect(await answering(404, 403).probe.privacy()).toBe('ANONYMOUS_READ_ALLOWED');
  });

  it('reports an unreachable endpoint, and lets any other fault through', async () => {
    const unreachable = createStorageStatusProbe(config, () =>
      Promise.reject(new TypeError('fetch failed')),
    );
    expect(await unreachable.privacy()).toBe('STORAGE_UNREACHABLE');
    const faulty = createStorageStatusProbe(config, () =>
      Promise.reject(new Error('unexpected')),
    );
    await expect(faulty.privacy()).rejects.toThrow('unexpected');
  });
});
