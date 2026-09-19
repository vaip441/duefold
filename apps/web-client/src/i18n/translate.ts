/**
 * Message lookup. English is the only 1.0 locale, so this resolves against one
 * catalogue rather than negotiating a locale; the indirection exists so that
 * adding a locale never means editing a component.
 */

import { messages, type MessageKey } from './en.ts';

export type { MessageKey } from './en.ts';

export type MessageValues = Readonly<Record<string, string | number>>;

/** Substitutes `{name}` placeholders. An unknown placeholder is left intact. */
export function translate(key: MessageKey, values?: MessageValues): string {
  const template = messages[key];
  if (values === undefined) return template;
  return template.replace(/\{(\w+)\}/gu, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}
