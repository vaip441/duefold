export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export class FixedClock implements Clock {
  readonly #instant: Date;

  public constructor(instant: Date) {
    this.#instant = new Date(instant.getTime());
  }

  public now(): Date {
    return new Date(this.#instant.getTime());
  }
}

export function addSeconds(instant: Date, seconds: number): Date {
  return new Date(instant.getTime() + seconds * 1_000);
}
