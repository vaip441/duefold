import { describe, expect, it } from 'vitest';
import { parseTrustedProxies } from './proxy.ts';

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
