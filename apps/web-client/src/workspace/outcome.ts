/**
 * How a client mutation reports what happened: one convention, because there were three.
 *
 * A REFUSAL IS A VALUE, NOT A REJECTION. `presentFailure` already turns each one into the
 * copy and recovery it earns, so rejecting would make every caller catch and decide again,
 * and a caller that forgot would raise an unhandled rejection instead of showing a denied
 * state. Rejection keeps its usual meaning: a fault.
 *
 * Returning it also settles WHOSE failure it is. A shared failure field needed a provenance
 * record so a surface could check before presenting; a value returned to the caller cannot
 * belong to another operation, and it dies when that surface unmounts.
 */

import { presentFailure, type PresentedFailure } from './failures.ts';

/** A mutation's answer: the value it produced, or the refusal to present. */
export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: PresentedFailure };

/**
 * Runs work and reports its outcome instead of rejecting.
 *
 * An abort is not an outcome: the caller that aborted no longer wants an answer, and
 * presenting "the request was cancelled" to someone who navigated away is noise. It
 * propagates, so a component unmounting mid-request stays silent.
 */
export async function settle<T>(work: Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await work };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return { ok: false, failure: presentFailure(error) };
  }
}

/** For a mutation whose only question is whether it committed: `null` means it did. */
export async function committed(work: Promise<unknown>): Promise<PresentedFailure | null> {
  const outcome = await settle(work);
  return outcome.ok ? null : outcome.failure;
}
