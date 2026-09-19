/**
 * OTP state machine tests.
 *
 * These protect the anti-enumeration properties, not just the happy path. Each
 * test is written so it FAILS if the property it guards is broken: if a future
 * edit derives expiry from a server response, treats an uninvited address
 * differently, or lets a client guess override a server rejection, one of these
 * breaks.
 */

import { describe, expect, it } from 'vitest';
import {
  attemptsExhausted,
  codeExpired,
  codeSyntaxValid,
  emailSyntaxValid,
  initialOtpState,
  otpReducer,
  OTP_LIFETIME_MS,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_MS,
  resendSecondsRemaining,
  submissionBlocked,
  type OtpEvent,
  type OtpState,
} from './otp-machine.ts';

const CHALLENGE = 'a'.repeat(32);
const T0 = 1_800_000_000_000;

function run(events: readonly OtpEvent[], from: OtpState = initialOtpState): OtpState {
  return events.reduce(otpReducer, from);
}

function atCodeStage(now = T0): OtpState {
  return run([
    { kind: 'email-changed', email: 'viewer@example.com' },
    { kind: 'request-started' },
    { kind: 'request-succeeded', challengeId: CHALLENGE, now, resend: false },
  ]);
}

function codeStage(state: OtpState): Extract<OtpState['stage'], { kind: 'code' }> {
  if (state.stage.kind !== 'code') throw new Error('expected the code stage');
  return state.stage;
}

describe('address step', () => {
  it('rejects malformed addresses locally without contacting the server', () => {
    for (const invalid of ['', 'viewer', 'viewer@', '@example.com', 'a b@example.com', 'x@y'])
      expect(emailSyntaxValid(invalid), invalid).toBe(false);
    for (const valid of ['viewer@example.com', 'first.last+tag@sub.example.co.uk'])
      expect(emailSyntaxValid(valid), valid).toBe(true);
  });

  it('accepts any syntactically valid address, revealing nothing about eligibility', () => {
    // A client-side check that could distinguish an invited address from an
    // uninvited one would defeat the server's neutral response.
    expect(emailSyntaxValid('never-invited@example.com')).toBe(true);
    expect(emailSyntaxValid('viewer@example.com')).toBe(true);
  });

  it('marks the field invalid without leaving the address step', () => {
    const state = run([{ kind: 'email-changed', email: 'nope' }, { kind: 'request-invalid' }]);
    expect(state.emailInvalid).toBe(true);
    expect(state.stage.kind).toBe('address');
    expect(state.busy).toBe('idle');
  });

  it('clears validation as soon as the address changes', () => {
    const state = run(
      [{ kind: 'email-changed', email: 'viewer@example.com' }],
      run([{ kind: 'email-changed', email: 'nope' }, { kind: 'request-invalid' }]),
    );
    expect(state.emailInvalid).toBe(false);
  });
});

describe('neutral challenge creation', () => {
  it('reaches exactly the same state for an invited and an uninvited address', () => {
    // The server answers identically, and so must the machine: any divergence
    // here would be observable in the UI.
    const invited = run([
      { kind: 'email-changed', email: 'viewer@example.com' },
      { kind: 'request-started' },
      { kind: 'request-succeeded', challengeId: CHALLENGE, now: T0, resend: false },
    ]);
    const uninvited = run([
      { kind: 'email-changed', email: 'stranger@example.com' },
      { kind: 'request-started' },
      { kind: 'request-succeeded', challengeId: CHALLENGE, now: T0, resend: false },
    ]);
    expect({ ...invited, email: '' }).toStrictEqual({ ...uninvited, email: '' });
    expect(invited.stage).toStrictEqual(uninvited.stage);
  });

  it('starts a fresh attempt budget and cooldown', () => {
    const stage = codeStage(atCodeStage());
    expect(stage.attempts).toBe(0);
    expect(stage.notice).toBe('sent');
    expect(stage.resendableAt).toBe(T0 + OTP_RESEND_COOLDOWN_MS);
  });
});

describe('resend cooldown', () => {
  it('counts down 60 seconds and then permits a resend', () => {
    const stage = codeStage(atCodeStage());
    expect(resendSecondsRemaining(stage, T0)).toBe(60);
    expect(resendSecondsRemaining(stage, T0 + 30_000)).toBe(30);
    expect(resendSecondsRemaining(stage, T0 + OTP_RESEND_COOLDOWN_MS)).toBe(0);
    expect(resendSecondsRemaining(stage, T0 + OTP_RESEND_COOLDOWN_MS + 5_000)).toBe(0);
  });

  it('resets the attempt budget on resend, because the prior challenge is invalidated', () => {
    const after = run(
      [
        { kind: 'verify-started' },
        { kind: 'verify-rejected', now: T0 + 1_000 },
        { kind: 'request-started' },
        {
          kind: 'request-succeeded',
          challengeId: 'b'.repeat(32),
          now: T0 + 61_000,
          resend: true,
        },
      ],
      atCodeStage(),
    );
    const stage = codeStage(after);
    expect(stage.attempts).toBe(0);
    expect(stage.notice).toBe('resent');
    expect(stage.challengeId).toBe('b'.repeat(32));
    expect(after.code).toBe('');
  });
});

describe('code entry', () => {
  it('requires exactly eight digits', () => {
    expect(codeSyntaxValid('12345678')).toBe(true);
    expect(codeSyntaxValid('1234567')).toBe(false);
    expect(codeSyntaxValid('123456789')).toBe(false);
    expect(codeSyntaxValid('1234567a')).toBe(false);
    expect(codeSyntaxValid('')).toBe(false);
  });
});

describe('rejection carries no server reason', () => {
  it('reports a neutral rejection while attempts remain and the code is live', () => {
    const state = run(
      [{ kind: 'verify-started' }, { kind: 'verify-rejected', now: T0 + 5_000 }],
      atCodeStage(),
    );
    const stage = codeStage(state);
    expect(stage.notice).toBe('rejected');
    expect(stage.attempts).toBe(1);
    // The field is cleared so the next attempt is deliberate.
    expect(state.code).toBe('');
    expect(state.busy).toBe('idle');
  });

  it('never contradicts the server: a rejection stays a rejection', () => {
    // Even when the client believes the code is live and unexhausted, the
    // outcome is the server's. There is no branch that turns a 401 into success.
    const state = run(
      [{ kind: 'verify-started' }, { kind: 'verify-rejected', now: T0 }],
      atCodeStage(),
    );
    expect(state.stage.kind).toBe('code');
    expect(codeStage(state).notice).not.toBe('none');
  });
});

describe('client-observed expiry', () => {
  it('treats the code as expired only after the published ten-minute lifetime', () => {
    const stage = codeStage(atCodeStage());
    expect(codeExpired(stage, T0)).toBe(false);
    expect(codeExpired(stage, T0 + OTP_LIFETIME_MS - 1)).toBe(false);
    expect(codeExpired(stage, T0 + OTP_LIFETIME_MS)).toBe(true);
  });

  it('derives expiry from elapsed time, not from any server response', () => {
    // A rejection AFTER the lifetime elapsed reports expiry; the identical
    // rejection BEFORE it does not. The difference is the clock, not the reply.
    const late = run(
      [{ kind: 'verify-started' }, { kind: 'verify-rejected', now: T0 + OTP_LIFETIME_MS }],
      atCodeStage(),
    );
    const early = run(
      [{ kind: 'verify-started' }, { kind: 'verify-rejected', now: T0 + 1_000 }],
      atCodeStage(),
    );
    expect(codeStage(late).notice).toBe('expired');
    expect(codeStage(early).notice).toBe('rejected');
  });

  it('blocks further submission once expired', () => {
    const stage = codeStage(atCodeStage());
    expect(submissionBlocked(stage, T0)).toBe(false);
    expect(submissionBlocked(stage, T0 + OTP_LIFETIME_MS)).toBe(true);
  });
});

describe('client-observed attempt lockout', () => {
  it('locks after five submitted attempts', () => {
    let state = atCodeStage();
    for (let attempt = 1; attempt <= OTP_MAX_ATTEMPTS; attempt += 1) {
      state = run(
        [{ kind: 'verify-started' }, { kind: 'verify-rejected', now: T0 + attempt * 1_000 }],
        state,
      );
      const stage = codeStage(state);
      expect(stage.attempts).toBe(attempt);
      if (attempt < OTP_MAX_ATTEMPTS) {
        expect(stage.notice, `attempt ${attempt}`).toBe('rejected');
        expect(attemptsExhausted(stage)).toBe(false);
      }
    }
    const final = codeStage(state);
    expect(final.notice).toBe('exhausted');
    expect(attemptsExhausted(final)).toBe(true);
    expect(submissionBlocked(final, T0)).toBe(true);
  });

  it('counts only attempts this client submitted, which the server never discloses', () => {
    const state = run(
      [
        { kind: 'verify-started' },
        { kind: 'verify-rejected', now: T0 + 1_000 },
        { kind: 'verify-started' },
        { kind: 'verify-rejected', now: T0 + 2_000 },
      ],
      atCodeStage(),
    );
    expect(codeStage(state).attempts).toBe(2);
  });

  it('reports lockout rather than expiry when both are true', () => {
    // Lockout is the more actionable statement: a new code is required either
    // way, and the copy for lockout says so.
    let state = atCodeStage();
    for (let attempt = 1; attempt <= OTP_MAX_ATTEMPTS; attempt += 1)
      state = run(
        [{ kind: 'verify-started' }, { kind: 'verify-rejected', now: T0 + OTP_LIFETIME_MS }],
        state,
      );
    expect(codeStage(state).notice).toBe('exhausted');
  });
});

describe('transport failures', () => {
  it('surfaces a rate limit at the address step without a challenge', () => {
    const state = run([
      { kind: 'email-changed', email: 'viewer@example.com' },
      { kind: 'request-started' },
      { kind: 'request-failed', notice: 'paused' },
    ]);
    expect(state.stage.kind).toBe('address');
    expect(state.addressNotice).toBe('paused');
    expect(state.busy).toBe('idle');
  });

  it('surfaces a rate limit on a resend without losing the open challenge', () => {
    const state = run(
      [{ kind: 'request-started' }, { kind: 'request-failed', notice: 'paused' }],
      atCodeStage(),
    );
    const stage = codeStage(state);
    expect(stage.notice).toBe('paused');
    expect(stage.challengeId).toBe(CHALLENGE);
    expect(stage.attempts).toBe(0);
  });

  it('distinguishes offline from unavailable without inventing a cause', () => {
    for (const notice of ['offline', 'unavailable'] as const) {
      const state = run(
        [{ kind: 'verify-started' }, { kind: 'verify-failed', notice }],
        atCodeStage(),
      );
      expect(codeStage(state).notice).toBe(notice);
      // A transport failure is not an attempt: the budget is untouched.
      expect(codeStage(state).attempts).toBe(0);
    }
  });
});

describe('completion and restart', () => {
  it('reaches the authenticated stage and clears the entered code', () => {
    const state = run(
      [{ kind: 'verify-started' }, { kind: 'verify-succeeded' }],
      atCodeStage(),
    );
    expect(state.stage.kind).toBe('authenticated');
    expect(state.code).toBe('');
  });

  it('restart returns to the address step keeping only the typed address', () => {
    const state = run([{ kind: 'restart' }], atCodeStage());
    expect(state.stage.kind).toBe('address');
    expect(state.email).toBe('viewer@example.com');
    expect(state.code).toBe('');
    expect(state.addressNotice).toBe('none');
  });
});

describe('countdown display', () => {
  it('never reads above the 60-second cooldown', () => {
    // The clock advances between the request and the first render, so an
    // unclamped ceiling would display "61 seconds" on a fresh challenge.
    const stage = codeStage(atCodeStage(T0));
    expect(resendSecondsRemaining(stage, T0 - 500)).toBe(60);
    expect(resendSecondsRemaining(stage, T0)).toBe(60);
    expect(resendSecondsRemaining(stage, T0 + 1)).toBe(60);
  });
});
