/**
 * Reads an `AbortSignal`'s current state.
 *
 * This exists because narrowing is wrong here: after one `if (signal.aborted)`
 * guard, the compiler treats the property as permanently `false`, even though an
 * `await` in between can abort it. Routing every check through a call keeps each
 * one a real read of the current value rather than a compile-time assumption,
 * which is what makes the post-await cancellation guards load-bearing.
 */
export function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}
