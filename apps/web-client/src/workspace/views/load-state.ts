/**
 * Which designed state a failed load earns, and which recovery goes with it.
 *
 * Extracted from `AdministrationView` so the rule is testable without mounting a view
 * that needs a DOM and a server, and so there is exactly one definition of it.
 *
 * The rule exists because the view once mapped EVERY failed load to a denial. An offline
 * browser, an ended session, a malformed response, and a server fault all rendered "not
 * available to your role": an authorization cause none of them had, the real copy
 * suppressed, and no way forward. A denial is the server's refusal and nothing else.
 */

import type { PresentedFailure } from '../failures.ts';

/**
 * What the surface offers a member whose load failed.
 *
 * `retry` is for a load that may succeed UNCHANGED once a connection or a server
 * recovers. `sign-in` is for one that cannot: the request would be refused again on the
 * same session, so a retry button would be an action that cannot work. `none` belongs to
 * a denial, where retrying is refused again and offering it would imply the refusal might
 * be transient.
 */
export type LoadRecovery = 'retry' | 'sign-in' | 'none';

export interface LoadClassification {
  /** The server REFUSED the reader. Terminal, discloses nothing, offers no retry. */
  readonly denied: boolean;
  /** The load failed for any other reason, and names its own cause and recovery. */
  readonly failedLoad: boolean;
  readonly recovery: LoadRecovery;
}

export function classifyLoad(input: {
  readonly failed: boolean;
  readonly failure: PresentedFailure | null;
}): LoadClassification {
  if (!input.failed) return { denied: false, failedLoad: false, recovery: 'none' };
  /*
   * Denial is asserted, never assumed. A failure whose cause was not established is a
   * failure: claiming an authorization cause nobody determined would tell a member their
   * role is insufficient when the real answer might be to reconnect or sign in again.
   */
  const denied = input.failure?.kind === 'denied';
  if (denied) return { denied: true, failedLoad: false, recovery: 'none' };
  return { denied: false, failedLoad: true, recovery: recoveryFor(input.failure) };
}

/**
 * The recovery a failure class earns.
 *
 * Derived from the class rather than chosen by the component, because the copy and the
 * control have to agree. A stale-authentication refusal read "this change needs a fresh
 * sign-in" above a button labelled "Load members again": the copy named the right
 * recovery and the only control offered the wrong one, so following the button produced
 * the same refusal and the member had no way to reach the instruction they were given.
 */
function recoveryFor(failure: PresentedFailure | null): LoadRecovery {
  if (failure === null) return 'retry';
  switch (failure.kind) {
    /* Neither can succeed on this session: one has no session left, and the other needs a
       new authentication the browser cannot obtain by repeating the request. */
    case 'session-ended':
    case 'fresh-oidc':
      return 'sign-in';
    /* Offline, a server fault, a malformed response, and a stale revision all describe a
       request that may succeed unchanged once the cause clears. */
    case 'offline':
    case 'plain':
    case 'conflict':
      return 'retry';
    case 'denied':
      return 'none';
  }
}
