import { describe, expect, it } from 'vitest';
import { FixedClock } from './clock.ts';
import { normalizeEmail } from './email.ts';
import {
  createCorrelationId,
  createOpaqueId,
  createOpaqueSecret,
  isCorrelationId,
  isOpaqueId,
} from './ids.ts';
import { allowlistedTelemetry } from './redact.ts';

describe('opaque identifiers', () => {
  it('uses independent URL-safe 192-bit random values', () => {
    const values = new Set(Array.from({ length: 1_000 }, createOpaqueId));
    expect(values.size).toBe(1_000);
    for (const value of values) expect(isOpaqueId(value)).toBe(true);
    expect(createOpaqueSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const correlationId = createCorrelationId();
    expect(isCorrelationId(correlationId)).toBe(true);
    expect(isOpaqueId(correlationId)).toBe(false);
  });
});

describe('email normalization', () => {
  it('trims, NFC normalizes and compares both parts case-insensitively', () => {
    expect(normalizeEmail('  JoSe\u0301+Fund@ExAmPle.COM  ')).toEqual({
      display: 'JoSé+Fund@ExAmPle.COM',
      comparisonKey: 'josé+fund@example.com',
    });
  });

  it('preserves display spelling and never strips dots or plus tags', () => {
    const normalized = normalizeEmail('First.Last+Deal@Example.com');
    expect(normalized.display).toBe('First.Last+Deal@Example.com');
    expect(normalized.comparisonKey).toBe('first.last+deal@example.com');
    expect(normalizeEmail('firstlast@example.com').comparisonKey).not.toBe(
      normalized.comparisonKey,
    );
  });
});

describe('clock', () => {
  it('returns defensive UTC instant copies', () => {
    const clock = new FixedClock(new Date('2026-03-01T00:00:00.000Z'));
    expect(clock.now().toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });
});

describe('telemetry allowlist', () => {
  it('drops every non-allowlisted category instead of redacting heuristically', () => {
    const protectedId = createOpaqueId();
    const result = allowlistedTelemetry({
      event: 'request.failed',
      status: 500,
      message: `board.pdf Investor@Example.com private/key ${protectedId}`,
      requestBody: 'confidential body',
      documentContent: 'content',
      sourceFilename: 'board.pdf',
      email: 'Investor@Example.com',
      otpCode: '12345678',
      accessToken: 'abc',
      objectKey: 'private/key',
      roomId: protectedId,
      ip: '192.0.2.10',
    });
    expect(result).toEqual({ event: 'request.failed', status: 500 });
  });

  it('drops sensitive free text even when placed under allowlisted keys', () => {
    expect(
      allowlistedTelemetry({
        event: 'Investor@example.com board.pdf private/object-key',
        code: 'Bearer secret-token',
        service: 'room-id-123',
        correlation: 'Investor@example.com',
      }),
    ).toEqual({});
  });

  it('accepts only the distinct branded correlation wire format', () => {
    const correlation = createCorrelationId();
    expect(allowlistedTelemetry({ correlation })).toEqual({ correlation });
    expect(allowlistedTelemetry({ correlation: createOpaqueId() })).toEqual({});
  });

  it('accepts only closed-vocabulary startup stages', () => {
    expect(allowlistedTelemetry({ stage: 'oidc' })).toEqual({ stage: 'oidc' });
    expect(allowlistedTelemetry({ stage: 'board.pdf' })).toEqual({});
  });

  it('drops nested and unknown structured fields', () => {
    expect(
      allowlistedTelemetry({
        code: 'REQUEST_FAILED',
        detail: { filename: 'board.pdf' },
        message: 'secret-token',
      }),
    ).toEqual({ code: 'REQUEST_FAILED' });
  });
});
