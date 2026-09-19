/**
 * In-document find over a page's sanitized text layer.
 *
 * This is deliberately a pure function of (items, query): the reader component
 * holds no search state the server did not give it, and find never issues a
 * request. A viewer typing in the find box must not produce network traffic that
 * discloses what they are looking for.
 *
 * Matching is case- and accent-insensitive so a viewer searching "resume" finds
 * "Résumé". It compares NFC-normalized, case-folded text, and maps the match
 * back to the ORIGINAL item index, because the highlight must land on the item
 * the viewer can see rather than on a normalized copy of it.
 */

import type { TextLayerItem } from '../api/client.ts';

export interface FindMatch {
  /** Index into the text layer's `items`. */
  readonly itemIndex: number;
  /** Start offset of the match within that item's own text. */
  readonly start: number;
  readonly end: number;
}

/**
 * Case- and diacritic-insensitive fold.
 *
 * Decomposing to NFD and stripping combining marks makes "Résumé" and "Resume"
 * compare equal. The result is only ever used for comparison; nothing rendered
 * comes from it, so folding cannot alter what the viewer reads.
 */
function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase();
}

/**
 * Finds every occurrence of `query` across the page's items, in reading order.
 *
 * Folding can change string length (a precomposed accent folds to one character,
 * a decomposed one to two), so offsets are recovered through an explicit map from
 * original index to folded index rather than by assuming they coincide. Assuming
 * they do would misplace a highlight on any page containing an accent.
 *
 * The END boundary deliberately takes the LAST original index whose folded length
 * equals the match end, not the first. A trailing combining mark folds away to
 * nothing, so the first index reaching the boundary sits before it and would clip
 * the final accent off the highlight.
 */
export function findMatches(
  items: readonly TextLayerItem[],
  query: string,
): readonly FindMatch[] {
  const needle = fold(query.trim());
  if (needle === '') return [];
  const matches: FindMatch[] = [];
  items.forEach((item, itemIndex) => {
    const text = item.text;
    // prefixFoldedLength[i] = folded length of text.slice(0, i).
    const prefixFoldedLength: number[] = [0];
    for (let index = 1; index <= text.length; index += 1)
      prefixFoldedLength.push(fold(text.slice(0, index)).length);
    const haystack = fold(text);
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) break;
      const start = prefixFoldedLength.findIndex((length) => length >= at);
      const target = at + needle.length;
      let end = -1;
      for (let index = prefixFoldedLength.length - 1; index >= 0; index -= 1) {
        const length = prefixFoldedLength[index];
        if (length !== undefined && length === target) {
          end = index;
          break;
        }
      }
      // No exact boundary (the match ends mid-character): take the first index
      // that covers it so the highlight never stops short of the match.
      if (end < 0) end = prefixFoldedLength.findIndex((length) => length >= target);
      matches.push({
        itemIndex,
        start: start < 0 ? 0 : start,
        end: end < 0 ? text.length : end,
      });
      from = target;
    }
  });
  return matches;
}

/** Splits an item's text into runs, marking which fall inside a match. */
export interface TextRun {
  readonly text: string;
  readonly matched: boolean;
  /** Index into the full match list, for current-match styling. */
  readonly matchIndex: number | null;
}

export function splitRuns(
  text: string,
  matches: readonly FindMatch[],
  itemIndex: number,
): readonly TextRun[] {
  const own = matches
    .map((match, matchIndex) => ({ match, matchIndex }))
    .filter((entry) => entry.match.itemIndex === itemIndex)
    .sort((left, right) => left.match.start - right.match.start);
  if (own.length === 0) return [{ text, matched: false, matchIndex: null }];
  const runs: TextRun[] = [];
  let cursor = 0;
  for (const { match, matchIndex } of own) {
    if (match.start > cursor)
      runs.push({ text: text.slice(cursor, match.start), matched: false, matchIndex: null });
    runs.push({ text: text.slice(match.start, match.end), matched: true, matchIndex });
    cursor = match.end;
  }
  if (cursor < text.length)
    runs.push({ text: text.slice(cursor), matched: false, matchIndex: null });
  return runs;
}
