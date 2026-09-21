/**
 * Failure presentation.
 *
 * The property under test is the one that has actually caused a security defect in
 * this codebase: a refusal must never be presented as an empty or neutral state,
 * and a stale-revision conflict must offer a RELOAD rather than a retry that would
 * reapply the stale revision over a colleague's change.
 */

import { describe, expect, it } from 'vitest';
import { presentFailure } from './failures.ts';
import { ApiError } from '../api/client.ts';

describe('presentFailure', () => {
  it('offers a reload for a conflict and never for anything else', () => {
    // Positive arm: a conflict is the one case where re-reading is the recovery.
    const conflict = presentFailure(new ApiError('conflict'));
    expect(conflict.kind).toBe('conflict');
    expect(conflict.offerReload).toBe(true);
    expect(conflict.body).toContain('Someone else changed this');

    // Negative arm: no other failure suggests reloading.
    for (const failure of [
      'denied',
      'invalid',
      'offline',
      'unauthenticated',
      'not-found',
      'rate-limited',
      'unavailable',
    ] as const)
      expect(presentFailure(new ApiError(failure)).offerReload, failure).toBe(false);
  });

  it('never tells a member to retry a conflict', () => {
    const conflict = presentFailure(new ApiError('conflict'));
    expect(conflict.body.toLowerCase()).not.toContain('try again');
    expect(conflict.body.toLowerCase()).toContain('reload');
  });

  it('reports a denial AS a refusal rather than as an empty or neutral state', () => {
    const denied = presentFailure(new ApiError('denied'));
    expect(denied.kind).toBe('denied');
    expect(denied.body).not.toBe('');
    // The wording must name the refusal, not describe absence of content.
    expect(denied.body).toContain('does not have access');
  });

  it('takes the stale-OIDC distinction from the server, never from the calling operation', () => {
    /*
     * The caller used to declare that a 403 meant "re-authenticate", which
     * mislabelled every ordinary refusal on grant and export calls as a stale
     * session and told members to sign in again when the real cause was a revoked
     * role. Only the server knows whether the broad-change predicate fired, so the
     * distinction now rides on its error code.
     */
    const fresh = presentFailure(new ApiError('fresh-authentication-required'));
    expect(fresh.kind).toBe('fresh-oidc');
    expect(fresh.body).toContain('recent sign-in');

    const ordinary = presentFailure(new ApiError('denied'));
    expect(ordinary.kind).toBe('denied');
    expect(ordinary.body).not.toContain('recent sign-in');
  });

  it('reports an unknown error as unavailable without leaking its text', () => {
    const presented = presentFailure(new Error('connection refused at 10.0.0.5:5432'));
    expect(presented.kind).toBe('plain');
    expect(presented.body).not.toContain('10.0.0.5');
    expect(presented.body).not.toContain('connection refused');
  });

  it('carries no server detail, status code, or correlation id for any failure class', () => {
    /*
     * The word "offline" legitimately appears in offline copy, so this asserts the
     * absence of MACHINE detail -- status codes, SQLSTATEs, correlation ids -- rather
     * than the absence of the failure name itself.
     */
    for (const failure of [
      'offline',
      'unauthenticated',
      'denied',
      'not-found',
      'rate-limited',
      'conflict',
      'invalid',
      'unavailable',
    ] as const) {
      const presented = presentFailure(new ApiError(failure));
      expect(presented.body, failure).not.toMatch(/corr_|SQLSTATE|\b\d{3,5}\b/u);
      expect(presented.body, failure).not.toContain('Error');
      expect(presented.body.length, failure).toBeGreaterThan(10);
    }
  });
});
