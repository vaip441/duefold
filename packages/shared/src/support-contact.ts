/**
 * Operator-configured support contact.
 *
 * The value is rendered on unauthenticated pages, so it is validated at
 * configuration load rather than at render time: a malformed or hostile value
 * must fail startup instead of reaching a public surface. Only an email address
 * or an `https:` URL is accepted; `javascript:`, `data:`, and plain `http:` are
 * rejected explicitly.
 */

import { normalizeEmail } from './email.ts';

export interface SupportContact {
  readonly kind: 'email' | 'url';
  /** Exactly what the operator configured, after normalization. */
  readonly value: string;
}

export class InvalidSupportContactError extends Error {
  public constructor() {
    super('Support contact must be an email address or an https URL');
    this.name = 'InvalidSupportContactError';
  }
}

/** Returns `null` when unconfigured; throws when configured and unusable. */
export function parseSupportContact(raw: string | undefined): SupportContact | null {
  /* URL parsers may discard ASCII tab/newline characters during normalization.
   * Reject them before trimming so attacker-influenced public output is never
   * accepted because the parser silently rewrote it. */
  if (
    raw !== undefined &&
    Array.from(raw).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127;
    })
  )
    throw new InvalidSupportContactError();
  const value = raw?.trim() ?? '';
  if (value === '') return null;
  if (value.includes('@') && !value.includes('/') && !value.includes(':')) {
    try {
      return { kind: 'email', value: normalizeEmail(value).display };
    } catch {
      throw new InvalidSupportContactError();
    }
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidSupportContactError();
  }
  if (url.protocol !== 'https:') throw new InvalidSupportContactError();
  if (url.username !== '' || url.password !== '') throw new InvalidSupportContactError();
  return { kind: 'url', value: url.toString() };
}
