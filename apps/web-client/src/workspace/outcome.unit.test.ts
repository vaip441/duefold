/**
 * The mutation-result convention.
 *
 * These are the properties every caller depends on: a refusal arrives as a value already
 * presented, an abort is not reported as a failure, and `committed` says "nothing went
 * wrong" with null rather than with a wrapper the caller must unwrap.
 */

import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client.ts';
import { committed, settle } from './outcome.ts';

describe('settle', () => {
  it('carries a value', async () => {
    expect(await settle(Promise.resolve(3))).toStrictEqual({ ok: true, value: 3 });
  });

  it('turns a refusal into its designed presentation instead of rejecting', async () => {
    /* Presented once, here, so no caller decides what a conflict reads like or which
       recovery it earns. */
    const outcome = await settle(Promise.reject(new ApiError('conflict')));
    expect(outcome).toMatchObject({
      ok: false,
      failure: { kind: 'conflict', offerReload: true },
    });
  });

  it('propagates an abort rather than presenting it', async () => {
    /*
     * A caller that aborted does not want an answer, so "the request was cancelled" would
     * be an error message shown to someone who navigated away. Treating it as a refusal
     * would also leave an unmounting component setting failure state.
     */
    await expect(
      settle(Promise.reject(new DOMException('aborted', 'AbortError'))),
    ).rejects.toBeInstanceOf(DOMException);
  });
});

describe('committed', () => {
  it('is null when the work committed and the failure when it did not', async () => {
    expect(await committed(Promise.resolve({}))).toBeNull();
    expect(await committed(Promise.reject(new ApiError('conflict')))).toMatchObject({
      kind: 'conflict',
    });
  });
});
