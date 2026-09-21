/**
 * How a failed member load is classified.
 *
 * `AdministrationView` decides which state the Members surface shows, and it once mapped
 * EVERY failed load to a denial. An offline browser, an ended session, a malformed
 * response, and a server fault all claimed "not available to your role": the wrong cause,
 * the wrong copy, and no recovery.
 *
 * The derivation is exercised as a pure function rather than by rendering the view, which
 * mounts a loader needing a DOM and a server. The rule is the part that was wrong, and the
 * rule is what these pin; `MembersPanel.unit.test.tsx` covers what each state renders.
 */

import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client.ts';
import { presentFailure, type FailureKind } from '../failures.ts';
import { classifyLoad } from './load-state.ts';

/** How the server's own refusal arrives: SQLSTATE 42501 rendered as a uniform 403. */
const DENIED = presentFailure(new ApiError('denied'));

describe('classifyLoad', () => {
  it('reports a denial as denied, with no recovery to offer', () => {
    /* Retrying a refusal is refused again, so offering one would present an action that
       cannot succeed and imply the denial might be transient. */
    expect(classifyLoad({ failed: true, failure: DENIED })).toStrictEqual({
      denied: true,
      failedLoad: false,
      recovery: 'none',
    });
  });

  it('reports an offline browser as a failure, not an authorization decision', () => {
    // The request may well succeed unchanged once the link returns, so it earns a retry.
    expect(
      classifyLoad({ failed: true, failure: presentFailure(new ApiError('offline')) }),
    ).toStrictEqual({ denied: false, failedLoad: true, recovery: 'retry' });
  });

  it('reports an ended session as a failure, and asks for sign-in', () => {
    // Retrying on a session that no longer exists produces another 401.
    expect(
      classifyLoad({
        failed: true,
        failure: presentFailure(new ApiError('unauthenticated')),
      }),
    ).toStrictEqual({ denied: false, failedLoad: true, recovery: 'sign-in' });
  });

  it('reports a server fault as a failure', () => {
    expect(
      classifyLoad({ failed: true, failure: presentFailure(new ApiError('unavailable')) }),
    ).toStrictEqual({ denied: false, failedLoad: true, recovery: 'retry' });
  });

  it('reports a malformed response as a failure', () => {
    // A parser refusal surfaces as `unavailable`: a disagreement about the wire contract,
    // not a statement about this member's authority.
    expect(
      classifyLoad({ failed: true, failure: presentFailure(new Error('parse')) }),
    ).toStrictEqual({ denied: false, failedLoad: true, recovery: 'retry' });
  });

  it('reports a stale-authentication refusal as a failure needing sign-in, not a denial', () => {
    /*
     * The server identified this as needing fresh OIDC, which has its own recovery.
     * Folding it into the denied state would tell the member their role is insufficient
     * when the real answer is to sign in again.
     *
     * The RECOVERY is the part that was still wrong: the class was distinguished but the
     * surface offered a reload for it, so copy saying "sign in again" sat above the only
     * control available, which reproduced the refusal. A repeated request cannot obtain a
     * newer authentication instant.
     */
    expect(
      classifyLoad({
        failed: true,
        failure: presentFailure(new ApiError('fresh-authentication-required')),
      }),
    ).toStrictEqual({ denied: false, failedLoad: true, recovery: 'sign-in' });
  });

  it('reports a stale revision as a failure a re-read can fix', () => {
    expect(
      classifyLoad({ failed: true, failure: presentFailure(new ApiError('conflict')) }),
    ).toStrictEqual({ denied: false, failedLoad: true, recovery: 'retry' });
  });

  it('claims neither state while the load is in flight or succeeded', () => {
    expect(classifyLoad({ failed: false, failure: null })).toStrictEqual({
      denied: false,
      failedLoad: false,
      recovery: 'none',
    });
    /* A failure reported alongside a SUCCESSFUL listing is a later page's failure, which
       the panel shows beside the rows it did read rather than instead of them. */
    expect(classifyLoad({ failed: false, failure: DENIED })).toStrictEqual({
      denied: false,
      failedLoad: false,
      recovery: 'none',
    });
  });

  it('treats a failure with no presented cause as a retryable failure, never a denial', () => {
    // Failing to a denial here would claim an authorization cause nobody established.
    expect(classifyLoad({ failed: true, failure: null })).toStrictEqual({
      denied: false,
      failedLoad: true,
      recovery: 'retry',
    });
  });

  /*
   * Every failure class reaches exactly one state, so a class added later cannot fall
   * through to a default that claims the wrong cause or offers an impossible action.
   */
  it('classifies every failure class, with sign-in only where a retry cannot work', () => {
    const classes: readonly FailureKind[] = [
      'conflict',
      'fresh-oidc',
      'denied',
      'session-ended',
      'offline',
      'plain',
    ];
    for (const kind of classes) {
      const result = classifyLoad({
        failed: true,
        failure: { kind, title: null, body: '', offerReload: false },
      });
      expect(result.denied, kind).toBe(kind === 'denied');
      expect(result.failedLoad, kind).toBe(kind !== 'denied');
      expect(result.recovery, kind).toBe(
        kind === 'denied'
          ? 'none'
          : kind === 'session-ended' || kind === 'fresh-oidc'
            ? 'sign-in'
            : 'retry',
      );
    }
  });
});
