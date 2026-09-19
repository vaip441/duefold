/**
 * Viewer OTP state machine.
 *
 * SECURITY-BEARING. The server deliberately collapses invalid code, expired
 * code, locked challenge, and never-invited address into ONE uniform 401
 * (`consumeOtp` returns a single `null`). That is a deliberate anti-enumeration
 * control, and this machine does not reconstruct the distinction the server
 * refused to make.
 *
 * The distinct `expired` and `exhausted` states are derived ONLY from facts this
 * client observes for itself:
 *   - expired: elapsed time since the code was requested, against the published
 *     ten-minute lifetime;
 *   - exhausted: this client's own count of submitted attempts, against five.
 *
 * Two consequences follow, and both are enforced here:
 *   1. The server always wins. If the client believes a code is still live and
 *      the server rejects it, the state is the neutral rejection — never a
 *      claim about why.
 *   2. Wording and timing are identical whether or not the address was invited.
 *      There is no early client-side check that could reveal an address is
 *      unknown before submission, and the request step transitions to the same
 *      state for every syntactically valid address.
 */

export const OTP_CODE_LENGTH = 8;
export const OTP_LIFETIME_MS = 600_000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_MS = 60_000;

export type OtpStage =
  /** Collecting the email address. */
  | { readonly kind: 'address' }
  /** A challenge exists. Identical for invited and uninvited addresses. */
  | {
      readonly kind: 'code';
      readonly challengeId: string;
      readonly requestedAt: number;
      readonly attempts: number;
      readonly resendableAt: number;
      readonly notice: OtpNotice;
    }
  | { readonly kind: 'authenticated' };

/** What the surface may say. Never a reason the server withheld. */
export type OtpNotice =
  | 'none'
  /** A code was requested. Says nothing about whether one will arrive. */
  | 'sent'
  | 'resent'
  /** Neutral rejection: the server declined and gave no reason. */
  | 'rejected'
  /** Client-observed: the ten-minute lifetime has elapsed. */
  | 'expired'
  /** Client-observed: this client has submitted five attempts. */
  | 'exhausted'
  /** Server said 429: cooldown and abuse limits are indistinguishable. */
  | 'paused'
  | 'unavailable'
  | 'offline';

export type OtpBusy = 'idle' | 'requesting' | 'verifying';

export interface OtpState {
  readonly stage: OtpStage;
  readonly busy: OtpBusy;
  /** Address as typed, preserved for display; never normalized for the user. */
  readonly email: string;
  /** Set only by client-side syntax validation, never by any server response. */
  readonly emailInvalid: boolean;
  readonly code: string;
  /** Transport-level notice at the address step, where no challenge exists yet. */
  readonly addressNotice: Extract<OtpNotice, 'none' | 'paused' | 'unavailable' | 'offline'>;
}

export const initialOtpState: OtpState = {
  stage: { kind: 'address' },
  busy: 'idle',
  email: '',
  emailInvalid: false,
  code: '',
  addressNotice: 'none',
};

export type OtpEvent =
  | { readonly kind: 'email-changed'; readonly email: string }
  | { readonly kind: 'code-changed'; readonly code: string }
  | { readonly kind: 'request-invalid' }
  | { readonly kind: 'request-started' }
  | {
      readonly kind: 'request-succeeded';
      readonly challengeId: string;
      readonly now: number;
      readonly resend: boolean;
    }
  | {
      readonly kind: 'request-failed';
      readonly notice: Extract<OtpNotice, 'paused' | 'unavailable' | 'offline'>;
    }
  | { readonly kind: 'verify-started' }
  | { readonly kind: 'verify-succeeded' }
  | {
      readonly kind: 'verify-rejected';
      readonly now: number;
    }
  | {
      readonly kind: 'verify-failed';
      readonly notice: Extract<OtpNotice, 'paused' | 'unavailable' | 'offline'>;
    }
  | { readonly kind: 'restart' };

/** Syntax only. Deliberately permissive: this must not hint at eligibility. */
export function emailSyntaxValid(email: string): boolean {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return false;
  if (/\s/u.test(trimmed)) return false;
  const domain = trimmed.slice(at + 1);
  return domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.');
}

export function codeSyntaxValid(code: string): boolean {
  return new RegExp(`^\\d{${OTP_CODE_LENGTH}}$`, 'u').test(code);
}

/** Client-observed expiry. Never a server signal. */
export function codeExpired(stage: Extract<OtpStage, { kind: 'code' }>, now: number): boolean {
  return now - stage.requestedAt >= OTP_LIFETIME_MS;
}

/** Client-observed attempt exhaustion. Never a server signal. */
export function attemptsExhausted(stage: Extract<OtpStage, { kind: 'code' }>): boolean {
  return stage.attempts >= OTP_MAX_ATTEMPTS;
}

export function resendSecondsRemaining(
  stage: Extract<OtpStage, { kind: 'code' }>,
  now: number,
): number {
  // Clamped to the cooldown so a fresh challenge reads "60 seconds" rather than
  // "61" when the clock has advanced a few milliseconds since the request.
  const remaining = Math.ceil((stage.resendableAt - now) / 1000);
  return Math.min(OTP_RESEND_COOLDOWN_MS / 1000, Math.max(0, remaining));
}

/** True when the code field should refuse further submission. */
export function submissionBlocked(
  stage: Extract<OtpStage, { kind: 'code' }>,
  now: number,
): boolean {
  return attemptsExhausted(stage) || codeExpired(stage, now);
}

function withNotice(stage: Extract<OtpStage, { kind: 'code' }>, notice: OtpNotice): OtpStage {
  return { ...stage, notice };
}

export function otpReducer(state: OtpState, event: OtpEvent): OtpState {
  switch (event.kind) {
    case 'email-changed':
      return { ...state, email: event.email, emailInvalid: false, addressNotice: 'none' };
    case 'code-changed':
      return { ...state, code: event.code };
    case 'request-invalid':
      return { ...state, emailInvalid: true, addressNotice: 'none' };
    case 'request-started':
      return { ...state, busy: 'requesting', emailInvalid: false, addressNotice: 'none' };
    case 'request-succeeded':
      return {
        ...state,
        busy: 'idle',
        code: '',
        addressNotice: 'none',
        stage: {
          kind: 'code',
          challengeId: event.challengeId,
          requestedAt: event.now,
          // A resend invalidates the prior challenge server-side, so the
          // client's attempt budget starts again with the new code.
          attempts: 0,
          resendableAt: event.now + OTP_RESEND_COOLDOWN_MS,
          notice: event.resend ? 'resent' : 'sent',
        },
      };
    case 'request-failed':
      // A challenge in flight keeps its own notice slot; at the address step the
      // notice has nowhere else to live.
      if (state.stage.kind === 'code')
        return { ...state, busy: 'idle', stage: withNotice(state.stage, event.notice) };
      return { ...state, busy: 'idle', addressNotice: event.notice };
    case 'verify-started':
      return { ...state, busy: 'verifying' };
    case 'verify-succeeded':
      return { ...state, busy: 'idle', code: '', stage: { kind: 'authenticated' } };
    case 'verify-rejected': {
      if (state.stage.kind !== 'code') return { ...state, busy: 'idle' };
      const attempts = state.stage.attempts + 1;
      const attempted: Extract<OtpStage, { kind: 'code' }> = {
        ...state.stage,
        attempts,
      };
      // The server rejected without saying why. Client-observed facts may
      // explain what to do next, but they never contradict the server: a
      // rejection is a rejection in every branch below.
      let notice: OtpNotice = 'rejected';
      if (attempts >= OTP_MAX_ATTEMPTS) notice = 'exhausted';
      else if (codeExpired(attempted, event.now)) notice = 'expired';
      return { ...state, busy: 'idle', code: '', stage: withNotice(attempted, notice) };
    }
    case 'verify-failed':
      return {
        ...state,
        busy: 'idle',
        stage:
          state.stage.kind === 'code' ? withNotice(state.stage, event.notice) : state.stage,
      };
    case 'restart':
      return { ...initialOtpState, email: state.email };
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}
