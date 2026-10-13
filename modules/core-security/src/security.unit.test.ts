import { describe, expect, it } from 'vitest';
import { FixedClock } from '@duefold/shared/clock';
import { hasFreshOidc } from './authorization.ts';
import {
  clientNetwork,
  generateOtp,
  invitationExpiry,
  networkCorrelation,
  otpUsable,
  OTP_MAX_ATTEMPTS,
} from './auth/otp.ts';
import { bootstrapEligible, parseOwnerAllowlist } from './auth/oidc.ts';
import {
  DEFAULT_ABSOLUTE_HOURS,
  DEFAULT_IDLE_MINUTES,
  sessionExpiry,
  validateSessionPolicy,
} from './sessions.ts';

describe('OTP policy', () => {
  it('generates exactly eight numeric random digits', () => {
    for (let index = 0; index < 100; index += 1) expect(generateOtp()).toMatch(/^\d{8}$/u);
  });
  it('expires after ten minutes or five failures', () => {
    const now = new Date('2026-03-01T00:00:00Z');
    expect(
      otpUsable(
        {
          state: 'pending',
          expiresAt: new Date(now.getTime() + 1),
          failedAttempts: OTP_MAX_ATTEMPTS - 1,
        },
        now,
      ),
    ).toBe(true);
    expect(otpUsable({ state: 'pending', expiresAt: now, failedAttempts: 0 }, now)).toBe(false);
    expect(
      otpUsable(
        {
          state: 'pending',
          expiresAt: new Date(now.getTime() + 1),
          failedAttempts: OTP_MAX_ATTEMPTS,
        },
        now,
      ),
    ).toBe(false);
  });
  it('sets invitations to seven days', () => {
    const now = new Date('2026-03-01T00:00:00Z');
    expect(invitationExpiry(new FixedClock(now)).toISOString()).toBe(
      '2026-03-08T00:00:00.000Z',
    );
  });
  it('rotates network correlation monthly', () => {
    const key = 'k'.repeat(32);
    const january = networkCorrelation('2001:db8::1', new Date('2026-01-31T23:00:00Z'), key);
    const february = networkCorrelation(
      '2001:0db8:0:0:0:0:0:1',
      new Date('2026-02-01T00:00:00Z'),
      key,
    );
    expect(january.period).toBe('2026-01');
    expect(february.period).toBe('2026-02');
    expect(january.hmac).not.toBe(february.hmac);
  });
  it('keys IPv6 clients by their /64 and IPv4-mapped clients as IPv4', () => {
    expect(clientNetwork('2001:db8:aa:bb:1:2:3:4')).toBe('2001:db8:aa:bb::/64');
    expect(clientNetwork('2001:0DB8:00AA:00BB:ffff::1')).toBe('2001:db8:aa:bb::/64');
    expect(clientNetwork('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(clientNetwork('::1')).toBe('0:0:0:0::/64');
    expect(clientNetwork('::ffff:192.0.2.7')).toBe('192.0.2.7');
    expect(clientNetwork(' 192.0.2.7 ')).toBe('192.0.2.7');
    expect(() => clientNetwork('not-an-address')).toThrow('invalid network address');
    const key = 'k'.repeat(32);
    const now = new Date('2026-01-15T00:00:00Z');
    expect(networkCorrelation('2001:db8:aa:bb::1', now, key).hmac).toBe(
      networkCorrelation('2001:db8:aa:bb:9:8:7:6', now, key).hmac,
    );
    expect(networkCorrelation('2001:db8:aa:bb::1', now, key).hmac).not.toBe(
      networkCorrelation('2001:db8:aa:bc::1', now, key).hmac,
    );
    expect(networkCorrelation('::ffff:192.0.2.7', now, key).hmac).toBe(
      networkCorrelation('192.0.2.7', now, key).hmac,
    );
  });
});
describe('sessions', () => {
  it('uses bounded 30 minute idle and 12 hour absolute defaults', () => {
    const now = new Date('2026-03-01T00:00:00Z');
    const expiry = sessionExpiry(now, {
      idleMinutes: DEFAULT_IDLE_MINUTES,
      absoluteHours: DEFAULT_ABSOLUTE_HOURS,
    });
    expect(expiry.idleExpiresAt.toISOString()).toBe('2026-03-01T00:30:00.000Z');
    expect(expiry.absoluteExpiresAt.toISOString()).toBe('2026-03-01T12:00:00.000Z');
    expect(() => validateSessionPolicy({ idleMinutes: 61, absoluteHours: 12 })).toThrow();
  });
});
describe('OIDC freshness', () => {
  it('accepts authentication within the last fifteen minutes only', () => {
    const now = new Date('2026-03-01T12:00:00Z');
    expect(hasFreshOidc(new Date(now.getTime() - 14 * 60_000), now)).toBe(true);
    expect(hasFreshOidc(new Date(now.getTime() - 16 * 60_000), now)).toBe(false);
  });
});
describe('owner bootstrap', () => {
  it('requires exact normalized allowlist identity', () => {
    const identity = {
      issuer: 'https://issuer',
      subject: 's',
      emailKey: 'owner+deal@example.com',
      emailDisplay: 'Owner+Deal@Example.com',
      authenticatedAt: new Date(),
      authenticationTimeAsserted: true,
    };
    expect(bootstrapEligible(identity, parseOwnerAllowlist('OWNER+DEAL@example.com'))).toBe(
      true,
    );
    expect(bootstrapEligible(identity, parseOwnerAllowlist('owner@example.com'))).toBe(false);
  });
  it('parses the owner allowlist once, ignoring empty entries', () => {
    expect(parseOwnerAllowlist(' Owner@Example.com, ,second@example.com,')).toEqual([
      'owner@example.com',
      'second@example.com',
    ]);
  });
  it('fails startup on a malformed or empty owner allowlist', () => {
    for (const raw of ['owner@example.com,jane@acme', ',', ' '])
      expect(() => parseOwnerAllowlist(raw)).toThrow(
        'invalid configuration: DUEFOLD_OWNER_EMAIL_ALLOWLIST',
      );
  });
});
