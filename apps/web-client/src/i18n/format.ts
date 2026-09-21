/**
 * Placeholder substitution, shared by every message catalogue.
 *
 * It lives apart from `translate.ts` because a module that contributes a browser
 * surface owns its own catalogue: its copy must be absent from the bundle when the
 * module is omitted, so it cannot be a key in the application's catalogue. Those
 * catalogues still need one substitution rule, and a second implementation of it
 * would be a second place for `{name}` to mean something slightly different.
 */

export type MessageValues = Readonly<Record<string, string | number>>;

/** Substitutes `{name}` placeholders. An unknown placeholder is left intact. */
export function formatMessage(template: string, values?: MessageValues): string {
  if (values === undefined) return template;
  return template.replace(/\{(\w+)\}/gu, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}
