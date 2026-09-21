import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client.ts';
import { presentFailure, type FailureKind } from '../failures.ts';
import { classifyLoad } from './load-state.ts';

const DENIED = presentFailure(new ApiError('denied'));

describe('classifyLoad', () => {
  it('reports a denial as denied, with no recovery to offer', () => {
    expect(classifyLoad({ failed: true, failure: DENIED })).toStrictEqual({
      denied: true,
      failedLoad: false,
      recovery: 'none',
    });
  });

  it('reports an offline browser as a failure, not an authorization decision', () => {
    expect(
      classifyLoad({ failed: true, failure: presentFailure(new ApiError('offline')) }),
    ).toStrictEqual({ denied: false, failedLoad: true, recovery: 'retry' });
  });

  it('reports an ended session as a failure, and asks for sign-in', () => {
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
    expect(
      classifyLoad({ failed: true, failure: presentFailure(new Error('parse')) }),
    ).toStrictEqual({ denied: false, failedLoad: true, recovery: 'retry' });
  });

  it('reports a stale-authentication refusal as a failure needing sign-in, not a denial', () => {
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
    expect(classifyLoad({ failed: false, failure: DENIED })).toStrictEqual({
      denied: false,
      failedLoad: false,
      recovery: 'none',
    });
  });

  it('treats a failure with no presented cause as a retryable failure, never a denial', () => {
    expect(classifyLoad({ failed: true, failure: null })).toStrictEqual({
      denied: false,
      failedLoad: true,
      recovery: 'retry',
    });
  });

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
