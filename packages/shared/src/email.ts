export interface NormalizedEmail {
  /** Trimmed, NFC-normalized spelling shown back to the participant. */
  readonly display: string;
  /** Case-insensitive local part and lowercase domain, used only for comparison. */
  readonly comparisonKey: string;
}

export class InvalidEmailError extends Error {
  public constructor() {
    super('Email address is invalid');
    this.name = 'InvalidEmailError';
  }
}

/** Normalizes email without dot removal or plus-tag rewriting. */
export function normalizeEmail(input: string): NormalizedEmail {
  const display = input.trim().normalize('NFC');
  const separator = display.lastIndexOf('@');
  if (
    separator <= 0 ||
    separator === display.length - 1 ||
    display.slice(0, separator).includes('@') ||
    /\s/u.test(display)
  ) {
    throw new InvalidEmailError();
  }
  const local = display.slice(0, separator);
  const domain = display.slice(separator + 1);
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) {
    throw new InvalidEmailError();
  }
  return {
    display,
    comparisonKey: `${local.toLocaleLowerCase('und')}@${domain.toLocaleLowerCase('und')}`,
  };
}
