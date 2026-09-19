import { describe, expect, it } from 'vitest';
import { buildTestWebApp, testWebRuntime } from '../../../test/support/web-runtime.ts';
import { parseTrustedProxies } from './proxy.ts';

describe('Fastify proxy trust and X-Forwarded-For handling', () => {
  it('ignores spoofed X-Forwarded-For by default (trustProxy off)', async () => {
    let capturedIp: string | undefined;
    const runtime = testWebRuntime();
    const app = await buildTestWebApp({
      runtime,
      authenticate: () => Promise.resolve(null),
      trustProxy: parseTrustedProxies(undefined),
    });
    app.get('/_test/client-ip', (request) => {
      capturedIp = request.ip;
      return { ip: request.ip };
    });

    const response = await app.inject({
      method: 'GET',
      url: '/_test/client-ip',
      headers: {
        'x-forwarded-for': '203.0.113.195',
      },
      remoteAddress: '127.0.0.1',
    });

    expect(response.statusCode).toBe(200);
    expect(capturedIp).toBe('127.0.0.1');
    expect(response.json()).toEqual({ ip: '127.0.0.1' });
    await app.close();
  });

  it('rejects trust-all and hop-count-only proxy configuration', () => {
    expect(() => parseTrustedProxies('true')).toThrow(
      'DUEFOLD_TRUSTED_PROXIES_TRUST_ALL_FORBIDDEN',
    );
    expect(() => parseTrustedProxies('1')).toThrow(
      'DUEFOLD_TRUSTED_PROXIES_HOP_COUNT_FORBIDDEN',
    );
  });

  it('resolves client IP only when the immediate peer matches a trusted CIDR/IP', async () => {
    let capturedIp: string | undefined;
    const runtime = testWebRuntime();
    const app = await buildTestWebApp({
      runtime,
      authenticate: () => Promise.resolve(null),
      trustProxy: parseTrustedProxies('127.0.0.1, 172.16.0.0/12'),
    });
    app.get('/_test/client-ip', (request) => {
      capturedIp = request.ip;
      return { ip: request.ip };
    });

    // Request from trusted proxy (127.0.0.1) -> trusts X-Forwarded-For
    await app.inject({
      method: 'GET',
      url: '/_test/client-ip',
      headers: {
        'x-forwarded-for': '203.0.113.195',
      },
      remoteAddress: '127.0.0.1',
    });
    expect(capturedIp).toBe('203.0.113.195');

    // Request from trusted Docker/private subnet -> trusts X-Forwarded-For
    await app.inject({
      method: 'GET',
      url: '/_test/client-ip',
      headers: {
        'x-forwarded-for': '203.0.113.195',
      },
      remoteAddress: '172.18.0.1',
    });
    expect(capturedIp).toBe('203.0.113.195');

    // Request from UNTRUSTED remote address (192.0.2.1) -> ignores X-Forwarded-For
    await app.inject({
      method: 'GET',
      url: '/_test/client-ip',
      headers: {
        'x-forwarded-for': '203.0.113.195',
      },
      remoteAddress: '192.0.2.1',
    });
    expect(capturedIp).toBe('192.0.2.1');

    await app.close();
  });
});
