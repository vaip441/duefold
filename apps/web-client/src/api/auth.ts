/**
 * Session bootstrap, OTP sign-in, and sign-out.
 *
 * Split out of api/client.ts, which had grown to hold every HTTP domain in one
 * file. The transport, CSRF handling, and failure classification stay shared in
 * transport.ts so there is exactly one place that talks to the network.
 */

import {
  ApiError,
  failureForStatus,
  isRecord,
  readJson,
  request,
  serverErrorCode,
} from './transport.ts';

export type SessionState =
  | { readonly authenticated: false }
  | { readonly authenticated: true; readonly principal: 'member' | 'viewer' };

/** Bootstraps the shell. Absent, expired, and revoked sessions look identical. */
export async function loadSession(signal?: AbortSignal): Promise<SessionState> {
  const response = await request({
    method: 'GET',
    path: '/api/auth/session',
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok)
    throw new ApiError(failureForStatus(response.status, await serverErrorCode(response)));
  const payload = await readJson(response);
  /*
   * Parse both documented union members STRICTLY. Coercing an unrecognized shape
   * into `{ authenticated: false }` would let a schema regression, proxy
   * corruption, or server bug masquerade as a valid anonymous identity, which
   * silently downgrades a signed-in principal instead of surfacing the designed
   * unavailable state. An absent, expired, or revoked session is still reported
   * by the server as an explicit `authenticated: false`, so the neutral case
   * remains indistinguishable.
   */
  if (!isRecord(payload) || typeof payload['authenticated'] !== 'boolean')
    throw new ApiError('unavailable');
  if (!payload['authenticated']) return { authenticated: false };
  const principal = payload['principal'];
  if (principal !== 'member' && principal !== 'viewer') throw new ApiError('unavailable');
  return { authenticated: true, principal };
}

/**
 * Requests an OTP challenge. The server answers identically whether or not the
 * address was invited, and this resolves with the same value in both cases.
 */
export async function requestOtp(email: string, signal?: AbortSignal): Promise<string> {
  const response = await request({
    method: 'POST',
    path: '/api/auth/otp/request',
    body: { email },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok)
    throw new ApiError(failureForStatus(response.status, await serverErrorCode(response)));
  const payload = await readJson(response);
  if (!isRecord(payload) || typeof payload['challengeId'] !== 'string')
    throw new ApiError('unavailable');
  return payload['challengeId'];
}

/**
 * Verifies a code. The server returns one uniform 401 for an invalid code, an
 * expired code, a locked challenge, and an address that was never invited, so a
 * rejection here carries no information about which occurred.
 */
export async function verifyOtp(
  input: { readonly challengeId: string; readonly code: string },
  signal?: AbortSignal,
): Promise<void> {
  const response = await request({
    method: 'POST',
    path: '/api/auth/otp/verify',
    body: input,
    ...(signal === undefined ? {} : { signal }),
  });
  if (response.ok) return;
  throw new ApiError(failureForStatus(response.status, await serverErrorCode(response)));
}

export async function signOut(
  principal: 'member' | 'viewer',
  scope: 'this-device' | 'everywhere',
): Promise<void> {
  const suffix = scope === 'everywhere' ? 'sign-out-all' : 'sign-out';
  const response = await request({
    method: 'POST',
    path: `/api/auth/${principal}/${suffix}`,
    body: {},
  });
  // A revoked session answering 401 is a completed sign-out, not a failure.
  if (response.ok || response.status === 401) return;
  throw new ApiError(failureForStatus(response.status, await serverErrorCode(response)));
}

/*
 * ---------------------------------------------------------------------------
 * Member workspace
 *
 * Every shape below is what the server chose to disclose. The client adds no
 * derived authority: `canPublish` is echoed from the server's decision and used
 * only to avoid offering a control the server would reject, never as a
 * permission. `changeKinds` is computed server-side from the same expression the
 * publication preview uses, so the workspace cannot show a pending marker the
 * publish preview disagrees with.
 * ---------------------------------------------------------------------------
 */
