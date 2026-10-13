import { describe, expect, it } from 'vitest';
import { parseTrustedProxies, resolveProxyTrust } from './proxy.ts';

describe('parseTrustedProxies', () => {
  it('defaults to false when unset or empty', () => {
    expect(parseTrustedProxies(undefined)).toBe(false);
    expect(parseTrustedProxies('')).toBe(false);
    expect(parseTrustedProxies('false')).toBe(false);
    expect(parseTrustedProxies('   ')).toBe(false);
  });

  it('rejects trust-all and hop-count-only settings', () => {
    expect(() => parseTrustedProxies('true')).toThrow(
      'DUEFOLD_TRUSTED_PROXIES_TRUST_ALL_FORBIDDEN',
    );
    expect(() => parseTrustedProxies('1')).toThrow(
      'DUEFOLD_TRUSTED_PROXIES_HOP_COUNT_FORBIDDEN',
    );
    expect(() => parseTrustedProxies('2')).toThrow(
      'DUEFOLD_TRUSTED_PROXIES_HOP_COUNT_FORBIDDEN',
    );
  });

  it('refuses a list with no entries rather than reading it as a direct deployment', () => {
    for (const value of [',', ' , ,'])
      expect(() => parseTrustedProxies(value)).toThrow('DUEFOLD_TRUSTED_PROXIES_EMPTY');
  });

  it('returns a single string for a single IP/CIDR/subnet', () => {
    expect(parseTrustedProxies('127.0.0.1')).toBe('127.0.0.1');
    expect(parseTrustedProxies('10.0.0.0/8')).toBe('10.0.0.0/8');
    expect(parseTrustedProxies('loopback')).toBe('loopback');
  });

  it('returns a string array for comma-separated IPs/CIDRs', () => {
    expect(parseTrustedProxies('127.0.0.1, 10.0.0.0/8, 172.16.0.0/12')).toEqual([
      '127.0.0.1',
      '10.0.0.0/8',
      '172.16.0.0/12',
    ]);
  });
});

describe('resolveProxyTrust', () => {
  it('fails startup when neither setting states the client-address source', () => {
    for (const [proxies, edgeHops] of [
      [undefined, undefined],
      ['', ''],
      ['  ', undefined],
    ] as const)
      expect(() => resolveProxyTrust(proxies, edgeHops)).toThrow(
        'DUEFOLD_CLIENT_ADDRESS_SOURCE_REQUIRED',
      );
  });

  it('keeps proxy trust off only when a direct deployment says so', () => {
    expect(resolveProxyTrust('false', undefined)).toBe(false);
  });

  it('accepts only "1" as an edge hop count', () => {
    expect(typeof resolveProxyTrust(undefined, '1')).toBe('function');
    for (const value of ['0', '2', 'true', 'false', ' 1', '01'])
      expect(() => resolveProxyTrust(undefined, value)).toThrow(
        'DUEFOLD_TRUSTED_EDGE_HOPS_INVALID',
      );
  });

  it('refuses edge hops together with any trusted-proxies value, including "false"', () => {
    for (const proxies of ['10.0.0.0/8', 'false', ','])
      expect(() => resolveProxyTrust(proxies, '1')).toThrow(
        'DUEFOLD_TRUSTED_EDGE_HOPS_WITH_TRUSTED_PROXIES',
      );
  });

  it('refuses an empty trusted-proxies list', () => {
    expect(() => resolveProxyTrust(',', undefined)).toThrow('DUEFOLD_TRUSTED_PROXIES_EMPTY');
  });

  it('still refuses trust-all and hop counts in trusted proxies', () => {
    expect(() => resolveProxyTrust('true', undefined)).toThrow(
      'DUEFOLD_TRUSTED_PROXIES_TRUST_ALL_FORBIDDEN',
    );
    expect(() => resolveProxyTrust('1', undefined)).toThrow(
      'DUEFOLD_TRUSTED_PROXIES_HOP_COUNT_FORBIDDEN',
    );
  });
});
