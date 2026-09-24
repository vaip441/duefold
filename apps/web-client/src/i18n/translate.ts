/**
 * Message lookup. English is the only 1.0 locale, so this resolves against one
 * catalogue rather than negotiating a locale; the indirection exists so that
 * adding a locale never means editing a component.
 */

import { formatMessage, type MessageValues } from './format.ts';
import { messages, type MessageKey } from './en.ts';

export type { MessageKey } from './en.ts';
export type { MessageValues } from './format.ts';

/** Substitutes `{name}` placeholders. An unknown placeholder is left intact. */
export function translate(key: MessageKey, values?: MessageValues): string {
  return formatMessage(messages[key], values);
}

/** Keys that also carry a `.one` form for a count of exactly one. */
export type CountedKey = {
  [K in MessageKey]: `${K}.one` extends MessageKey ? K : never;
}[MessageKey];

/**
 * A message whose wording depends on a count. English needs only "one" and "other",
 * so a counted key has a sibling `.one` form rather than a plural syntax to parse.
 */
export function translateCount(key: CountedKey, count: number, values?: MessageValues): string {
  const form = count === 1 ? (`${key}.one` as MessageKey) : key;
  return formatMessage(messages[form], { count, ...values });
}
