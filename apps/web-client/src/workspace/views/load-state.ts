import type { PresentedFailure } from '../failures.ts';

export type LoadRecovery = 'retry' | 'sign-in' | 'none';

export interface LoadClassification {
  readonly denied: boolean;
  readonly failedLoad: boolean;
  readonly recovery: LoadRecovery;
}

export function classifyLoad(input: {
  readonly failed: boolean;
  readonly failure: PresentedFailure | null;
}): LoadClassification {
  if (!input.failed) return { denied: false, failedLoad: false, recovery: 'none' };
  const denied = input.failure?.kind === 'denied';
  if (denied) return { denied: true, failedLoad: false, recovery: 'none' };
  return { denied: false, failedLoad: true, recovery: recoveryFor(input.failure) };
}

function recoveryFor(failure: PresentedFailure | null): LoadRecovery {
  if (failure === null) return 'retry';
  switch (failure.kind) {
    case 'session-ended':
    case 'fresh-oidc':
      return 'sign-in';
    case 'offline':
    case 'plain':
    case 'conflict':
      return 'retry';
    case 'denied':
      return 'none';
  }
}
