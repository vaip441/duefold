export class InvariantViolation extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvariantViolation';
  }
}

/** A failed security invariant aborts control flow; callers must not recover open. */
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new InvariantViolation(message);
  }
}
