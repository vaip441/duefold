/**
 * Support-contact validation tests.
 *
 * This value reaches an unauthenticated page and may be rendered as a link, so a
 * hostile or malformed value must fail at configuration load rather than at
 * render time.
 */

import { describe, expect, it } from 'vitest';
import { InvalidSupportContactError, parseSupportContact } from './support-contact.ts';

describe('unconfigured', () => {
  it('treats absent, empty, and whitespace as unconfigured rather than invalid', () => {
    expect(parseSupportContact(undefined)).toBeNull();
    expect(parseSupportContact('')).toBeNull();
    expect(parseSupportContact('   ')).toBeNull();
  });
});

describe('accepted values', () => {
  it('accepts an email address, preserving the entered spelling', () => {
    expect(parseSupportContact('Support@Example.com')).toStrictEqual({
      kind: 'email',
      value: 'Support@Example.com',
    });
  });

  it('accepts an https URL', () => {
    expect(parseSupportContact('https://example.com/help')).toStrictEqual({
      kind: 'url',
      value: 'https://example.com/help',
    });
  });
});

describe('rejected values', () => {
  it('rejects every non-https scheme, including the dangerous ones', () => {
    for (const hostile of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'http://example.com',
      'ftp://example.com',
      'file:///etc/passwd',
      'vbscript:msgbox(1)',
    ])
      expect(() => parseSupportContact(hostile), hostile).toThrow(InvalidSupportContactError);
  });

  it('rejects credential-bearing URLs', () => {
    expect(() => parseSupportContact('https://user:secret@example.com')).toThrow(
      InvalidSupportContactError,
    );
  });

  it('rejects a malformed email address', () => {
    for (const invalid of ['support@', '@example.com', 'support@example'])
      expect(() => parseSupportContact(invalid), invalid).toThrow(InvalidSupportContactError);
  });

  it('rejects text that is neither an address nor a URL', () => {
    expect(() => parseSupportContact('call the office')).toThrow(InvalidSupportContactError);
  });
});
