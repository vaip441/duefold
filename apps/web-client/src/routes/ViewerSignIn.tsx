/**
 * Viewer email OTP: request a code, then verify it.
 *
 * SECURITY-BEARING SURFACE. The server answers a code request identically whether
 * or not the address was invited, and delivery is asynchronous. This surface must
 * not leak the difference through wording, timing, or a different visual state:
 *   - one request path, one response handler, one resulting screen;
 *   - copy that says "if this address has access" rather than asserting an email
 *     was sent;
 *   - no client-side eligibility check, no address lookup, no differing delay;
 *   - the same neutral rejection wording regardless of cause.
 *
 * `expired` and `exhausted` are derived from client-observed facts only; see
 * `auth/otp-machine.ts` for why, and for why the server always wins.
 */

import { useEffect, useReducer, useRef, useState } from 'react';
import { ApiError, requestOtp, verifyOtp } from '../api/client.ts';
import { AuthSheet } from '../components/AuthSheet.tsx';
import { Notice, type NoticeTone } from '../components/Notice.tsx';
import { StatusRegion } from '../components/StatusRegion.tsx';
import type { ThemeChoice } from '../components/ThemeSelect.tsx';
import { translate, type MessageKey } from '../i18n/translate.ts';
import {
  attemptsExhausted,
  codeExpired,
  codeSyntaxValid,
  emailSyntaxValid,
  initialOtpState,
  otpReducer,
  OTP_CODE_LENGTH,
  OTP_MAX_ATTEMPTS,
  resendSecondsRemaining,
  submissionBlocked,
  type OtpNotice,
} from '../auth/otp-machine.ts';

const NOTICE_COPY: Readonly<Record<Exclude<OtpNotice, 'none'>, MessageKey>> = {
  sent: 'otp.sent.notice',
  resent: 'otp.resend.sent',
  rejected: 'otp.code.rejected',
  expired: 'otp.code.expired',
  exhausted: 'otp.code.exhausted',
  paused: 'otp.paused',
  unavailable: 'error.unavailable.body',
  offline: 'app.offline.body',
};

const NOTICE_TONE: Readonly<Record<Exclude<OtpNotice, 'none'>, NoticeTone>> = {
  sent: 'action',
  resent: 'action',
  rejected: 'problem',
  expired: 'caution',
  exhausted: 'caution',
  paused: 'caution',
  unavailable: 'problem',
  offline: 'problem',
};

function transportNotice(error: unknown): 'paused' | 'unavailable' | 'offline' {
  if (!(error instanceof ApiError)) return 'unavailable';
  if (error.failure === 'offline') return 'offline';
  if (error.failure === 'rate-limited') return 'paused';
  return 'unavailable';
}

export interface ViewerSignInProps {
  readonly theme: ThemeChoice;
  readonly onThemeChange: (choice: ThemeChoice) => void;
  readonly onChooseMember: () => void;
  readonly onAuthenticated: () => void;
}

export function ViewerSignIn({
  theme,
  onThemeChange,
  onChooseMember,
  onAuthenticated,
}: ViewerSignInProps): React.ReactElement {
  const [state, dispatch] = useReducer(otpReducer, initialOtpState);
  const [now, setNow] = useState(() => Date.now());
  const codeInput = useRef<HTMLInputElement>(null);
  const stage = state.stage;

  // One second tick, live only while a challenge is open: it drives the resend
  // countdown and the client-observed expiry, both of which are facts about
  // elapsed time rather than anything the server disclosed.
  useEffect(() => {
    if (stage.kind !== 'code') return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [stage.kind]);

  useEffect(() => {
    if (stage.kind === 'code') codeInput.current?.focus();
  }, [stage.kind]);

  useEffect(() => {
    if (stage.kind === 'authenticated') onAuthenticated();
  }, [stage.kind, onAuthenticated]);

  const submitAddress = (resend: boolean): void => {
    if (!emailSyntaxValid(state.email)) {
      dispatch({ kind: 'request-invalid' });
      return;
    }
    dispatch({ kind: 'request-started' });
    requestOtp(state.email).then(
      (challengeId) => {
        dispatch({ kind: 'request-succeeded', challengeId, now: Date.now(), resend });
      },
      (error: unknown) => {
        dispatch({ kind: 'request-failed', notice: transportNotice(error) });
      },
    );
  };

  const submitCode = (): void => {
    if (stage.kind !== 'code' || !codeSyntaxValid(state.code)) return;
    dispatch({ kind: 'verify-started' });
    verifyOtp({ challengeId: stage.challengeId, code: state.code }).then(
      () => {
        dispatch({ kind: 'verify-succeeded' });
      },
      (error: unknown) => {
        if (error instanceof ApiError && error.failure === 'unauthenticated') {
          dispatch({ kind: 'verify-rejected', now: Date.now() });
          return;
        }
        dispatch({ kind: 'verify-failed', notice: transportNotice(error) });
      },
    );
  };

  const busyMessage =
    state.busy === 'requesting'
      ? translate('signIn.email.pending')
      : state.busy === 'verifying'
        ? translate('otp.code.pending')
        : '';

  if (stage.kind === 'code') {
    const blocked = submissionBlocked(stage, now);
    const cooldown = resendSecondsRemaining(stage, now);
    const notice: OtpNotice = attemptsExhausted(stage)
      ? 'exhausted'
      : codeExpired(stage, now) && stage.notice !== 'paused'
        ? 'expired'
        : stage.notice;
    return (
      <AuthSheet
        title={translate('otp.sent.title')}
        lead={translate('otp.sent.body')}
        theme={theme}
        onThemeChange={onThemeChange}
        aside={
          <button
            type="button"
            className="df-textlink"
            onClick={() => {
              dispatch({ kind: 'restart' });
            }}
          >
            {translate('otp.restart')}
          </button>
        }
      >
        <form
          className="df-sheet__form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            submitCode();
          }}
        >
          {notice === 'none' ? null : (
            <Notice
              tone={NOTICE_TONE[notice]}
              role={NOTICE_TONE[notice] === 'problem' ? 'alert' : 'status'}
            >
              {translate(NOTICE_COPY[notice])}
            </Notice>
          )}
          <div className="df-field">
            <label className="df-field__label" htmlFor="df-otp-code">
              {translate('otp.code.label')}
            </label>
            <span className="df-field__help" id="df-otp-code-help">
              {translate('otp.code.help')}
            </span>
            <input
              ref={codeInput}
              id="df-otp-code"
              className="df-field__input df-field__input--code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={OTP_CODE_LENGTH}
              value={state.code}
              aria-describedby="df-otp-code-help df-otp-attempts"
              disabled={state.busy === 'verifying' || blocked}
              onChange={(event) => {
                dispatch({
                  kind: 'code-changed',
                  code: event.target.value.replace(/\D/gu, '').slice(0, OTP_CODE_LENGTH),
                });
              }}
            />
            <span className="df-field__help" id="df-otp-attempts">
              {translate('otp.attempts', {
                current: Math.min(stage.attempts + 1, OTP_MAX_ATTEMPTS),
                total: OTP_MAX_ATTEMPTS,
              })}
            </span>
          </div>
          <div className="df-sheet__actions">
            <button
              type="submit"
              className="df-button df-button--primary"
              data-busy={state.busy === 'verifying' ? 'true' : 'false'}
              disabled={state.busy !== 'idle' || blocked || !codeSyntaxValid(state.code)}
            >
              {state.busy === 'verifying'
                ? translate('otp.code.pending')
                : translate('otp.code.action')}
            </button>
            <button
              type="button"
              className="df-button"
              disabled={state.busy !== 'idle' || cooldown > 0}
              onClick={() => {
                submitAddress(true);
              }}
            >
              {translate('otp.resend.action')}
            </button>
            {cooldown > 0 ? (
              <span className="df-field__help" data-numeric>
                {translate('otp.resend.wait', { seconds: cooldown })}
              </span>
            ) : null}
          </div>
        </form>
        <StatusRegion message={busyMessage} label={translate('shell.status.region')} />
      </AuthSheet>
    );
  }

  return (
    <AuthSheet
      title={translate('signIn.viewer.title')}
      lead={translate('signIn.viewer.lead')}
      theme={theme}
      onThemeChange={onThemeChange}
      aside={
        <button type="button" className="df-textlink" onClick={onChooseMember}>
          {translate('signIn.member.link')}
        </button>
      }
    >
      <form
        className="df-sheet__form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submitAddress(false);
        }}
      >
        {state.addressNotice === 'none' ? null : (
          <Notice tone={NOTICE_TONE[state.addressNotice]} role="alert">
            {translate(NOTICE_COPY[state.addressNotice])}
          </Notice>
        )}
        <div className="df-field">
          <label className="df-field__label" htmlFor="df-otp-email">
            {translate('signIn.email.label')}
          </label>
          <span className="df-field__help" id="df-otp-email-help">
            {translate('signIn.email.help')}
          </span>
          <input
            id="df-otp-email"
            className="df-field__input"
            name="email"
            type="email"
            autoComplete="email"
            spellCheck={false}
            value={state.email}
            aria-describedby={
              state.emailInvalid ? 'df-otp-email-help df-otp-email-error' : 'df-otp-email-help'
            }
            aria-invalid={state.emailInvalid ? 'true' : undefined}
            disabled={state.busy === 'requesting'}
            onChange={(event) => {
              dispatch({ kind: 'email-changed', email: event.target.value });
            }}
          />
          {state.emailInvalid ? (
            <span className="df-field__error" id="df-otp-email-error">
              {translate('signIn.email.invalid')}
            </span>
          ) : null}
        </div>
        <div className="df-sheet__actions">
          <button
            type="submit"
            className="df-button df-button--primary"
            data-busy={state.busy === 'requesting' ? 'true' : 'false'}
            disabled={state.busy !== 'idle'}
          >
            {state.busy === 'requesting'
              ? translate('signIn.email.pending')
              : translate('signIn.email.action')}
          </button>
        </div>
      </form>
      <StatusRegion message={busyMessage} label={translate('shell.status.region')} />
    </AuthSheet>
  );
}
