import { randomBytes } from 'node:crypto';

const OPAQUE_ID_BYTES = 24;
const CORRELATION_PREFIX = 'corr_';
declare const correlationIdBrand: unique symbol;
export type CorrelationId = string & { readonly [correlationIdBrand]: true };

/** Generates a 192-bit opaque, URL-safe identifier with no semantic component. */
export function createOpaqueId(): string {
  return randomBytes(OPAQUE_ID_BYTES).toString('base64url');
}

/** Generates a correlation identifier whose reserved wire format cannot be a resource ID. */
export function createCorrelationId(): CorrelationId {
  const value = `${CORRELATION_PREFIX}${randomBytes(OPAQUE_ID_BYTES).toString('base64url')}`;
  if (!isCorrelationId(value)) throw new Error('CORRELATION_ID_GENERATION_FAILED');
  return value;
}

/** Generates a 256-bit opaque secret suitable for a session or CSRF token. */
export function createOpaqueSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function isOpaqueId(value: string): boolean {
  return /^[A-Za-z0-9_-]{32}$/.test(value);
}

export function isCorrelationId(value: unknown): value is CorrelationId {
  return typeof value === 'string' && /^corr_[A-Za-z0-9_-]{32}$/u.test(value);
}

export function requireCorrelationId(value: string): CorrelationId {
  if (!isCorrelationId(value)) throw new Error('INVALID_CORRELATION_ID');
  return value;
}
