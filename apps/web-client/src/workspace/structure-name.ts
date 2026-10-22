/**
 * A name as the DATABASE compares it.
 *
 * `canonical_structure_name` is `normalize(lower(btrim(value)), NFC)`, and PostgreSQL's
 * `btrim` defaults to stripping the SPACE character alone. JavaScript's `trim()` strips every
 * Unicode whitespace, so using it here would report a clash the server does not see and block
 * a name it would accept.
 *
 * This is convenience, not authority: uniqueness is a database constraint and its 409 is still
 * presented if two requests race.
 */
export function canonicalName(value: string): string {
  return value
    .replace(/^ +| +$/gu, '')
    .toLowerCase()
    .normalize('NFC');
}
