import { describe, expect, it } from 'vitest';
import { FixedClock } from '@duefold/shared/clock';
import { authorizeMember, canViewAudit, hasFreshOidc } from './authorization.ts';
import {
  generateOtp,
  invitationExpiry,
  networkCorrelation,
  otpUsable,
  OTP_MAX_ATTEMPTS,
} from './auth/otp.ts';
import { bootstrapEligible } from './auth/oidc.ts';
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
describe('role resolution', () => {
  const now = new Date('2026-03-01T12:00:00Z');
  it('grants global and room authority without custom roles', () => {
    expect(authorizeMember({ globalRole: 'admin' }, 'room.manage', now)).toBe(true);
    expect(
      authorizeMember({ globalRole: 'member', roomRole: 'contributor' }, 'room.manage', now),
    ).toBe(false);
    expect(
      authorizeMember({ globalRole: 'member', roomRole: 'manager' }, 'room.manage', now),
    ).toBe(true);
  });
  it('requires fresh OIDC for ownership transfer', () => {
    const fresh = new Date(now.getTime() - 14 * 60_000);
    const stale = new Date(now.getTime() - 16 * 60_000);
    expect(hasFreshOidc(fresh, now)).toBe(true);
    expect(
      authorizeMember(
        { globalRole: 'owner', oidcAuthenticatedAt: stale },
        'owner.transfer',
        now,
      ),
    ).toBe(false);
  });
  it('scopes audit visibility', () => {
    expect(
      canViewAudit({ globalRole: 'member', roomRole: 'contributor' }, 'installation'),
    ).toBe(false);
    expect(canViewAudit({ globalRole: 'member', roomRole: 'manager' }, 'room')).toBe(true);
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
    };
    expect(bootstrapEligible(identity, ['OWNER+DEAL@example.com'])).toBe(true);
    expect(bootstrapEligible(identity, ['owner@example.com'])).toBe(false);
  });
});
