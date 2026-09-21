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
