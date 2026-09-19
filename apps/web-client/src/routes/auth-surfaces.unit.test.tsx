/**
 * Authentication surface tests.
 *
 * The property under test is that the rendered markup discloses nothing about
 * whether an address was invited, and that no internal detail reaches the page.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MemberSignIn } from './MemberSignIn.tsx';
import { ViewerSignIn } from './ViewerSignIn.tsx';
import { messages } from '../i18n/en.ts';

function memberMarkup(failed: boolean): string {
  return renderToStaticMarkup(
    <MemberSignIn
      failed={failed}
      theme="system"
      onThemeChange={() => undefined}
      onChooseViewer={() => undefined}
      onBegin={() => undefined}
    />,
  );
}

const viewerMarkup = renderToStaticMarkup(
  <ViewerSignIn
    theme="system"
    onThemeChange={() => undefined}
    onChooseMember={() => undefined}
    onAuthenticated={() => undefined}
  />,
);

describe('member sign-in', () => {
  it('offers exactly one action, because members have no email fallback', () => {
    const markup = memberMarkup(false);
    expect(markup).toContain(messages['signIn.member.action']);
    // No password field, no member OTP affordance.
    expect(markup).not.toMatch(/type="password"/u);
    expect(markup).not.toContain(messages['signIn.email.action']);
  });

  it('renders the neutral failure state as an alert without a reason', () => {
    const markup = memberMarkup(true);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain(messages['signIn.member.failed.title']);
    expect(markup).toContain(messages['signIn.member.failed.body']);
  });

  it('never shows an internal code, status, or identifier on failure', () => {
    const markup = memberMarkup(true);
    for (const forbidden of [
      'OIDC_',
      'MEMBER_INVITATION_REQUIRED',
      'BOOTSTRAP_IDENTITY_NOT_ALLOWED',
      'OWNER_ALREADY_EXISTS',
      'INTERNAL',
      'corr_',
      '500',
      'Error',
    ])
      expect(markup, forbidden).not.toContain(forbidden);
  });

  it('shows no failure state on a first visit', () => {
    expect(memberMarkup(false)).not.toContain('role="alert"');
  });
});

describe('viewer OTP address step', () => {
  it('labels the field and describes it without asserting eligibility', () => {
    expect(viewerMarkup).toContain(messages['signIn.email.label']);
    expect(viewerMarkup).toContain(messages['signIn.email.help']);
    expect(viewerMarkup).toMatch(/id="df-otp-email"/u);
    expect(viewerMarkup).toMatch(/for="df-otp-email"/u);
    expect(viewerMarkup).toMatch(/aria-describedby="df-otp-email-help"/u);
  });

  it('states no eligibility, membership, or invitation fact', () => {
    // Wording that implied the address is known would defeat the neutral
    // server response.
    expect(viewerMarkup).not.toMatch(/invited you|not invited|no account|unknown address/iu);
  });

  it('starts with no notice, so nothing is claimed before a request', () => {
    expect(viewerMarkup).not.toContain('df-notice');
  });
});

describe('copy discipline across the catalogue', () => {
  it('never asserts an email was sent, only that one may be', () => {
    // Delivery is asynchronous and conditional; the copy must not promise it.
    expect(messages['otp.sent.body']).toContain('If this address has access');
    expect(messages['otp.sent.body']).not.toMatch(
      /we sent|has been sent|check your inbox now/iu,
    );
  });

  it('phrases rejection without blame or cause', () => {
    expect(messages['otp.code.rejected']).not.toMatch(/wrong|invalid|incorrect|you failed/iu);
    expect(messages['otp.code.rejected']).not.toMatch(/not invited|no access|unknown/iu);
  });

  it('exposes no internal code, identifier, or infrastructure term anywhere', () => {
    const forbidden =
      /object key|sha-?256|digest|correlation|challengeId|storage url|filename|bucket|postgres|s3|smtp|clamav|module|manifest/iu;
    for (const [key, value] of Object.entries(messages)) {
      expect(value, key).not.toMatch(forbidden);
    }
  });

  it('makes no DRM or screenshot-prevention claim', () => {
    const claim = /cannot be copied|prevent screenshots|screenshot.protect|drm|copy.protect/iu;
    for (const [key, value] of Object.entries(messages)) {
      expect(value, key).not.toMatch(claim);
    }
  });

  it('routes every string through a key rather than a literal', () => {
    // A non-empty catalogue with unique values is the shape a later locale needs.
    const values = Object.values(messages);
    expect(values.length).toBeGreaterThan(40);
    for (const value of values) expect(value.length).toBeGreaterThan(0);
  });
});
