/**
 * In-document find behaviour.
 *
 * These cover the cases that would silently break reading rather than fail
 * loudly: a highlight landing on the wrong characters, an accented word not
 * matching its unaccented query, and overlapping runs producing duplicate or
 * lost text. Each assertion reconstructs the original string from the runs, so a
 * regression that drops or duplicates a character fails here.
 */

import { describe, expect, it } from 'vitest';
import { findMatches, splitRuns } from './find.ts';
import type { TextLayerItem } from '../api/client.ts';

function item(text: string): TextLayerItem {
  return { text, x: 0, y: 0, width: 1, height: 1 };
}

describe('findMatches', () => {
  it('finds every occurrence across items in reading order', () => {
    const matches = findMatches([item('revenue and revenue'), item('Revenue')], 'revenue');
    expect(matches).toEqual([
      { itemIndex: 0, start: 0, end: 7 },
      { itemIndex: 0, start: 12, end: 19 },
      { itemIndex: 1, start: 0, end: 7 },
    ]);
  });

  it('matches case- and accent-insensitively', () => {
    expect(findMatches([item('Résumé attached')], 'resume')).toEqual([
      { itemIndex: 0, start: 0, end: 6 },
    ]);
  });

  it('maps offsets back onto the original text when folding changes length', () => {
    // NFD input: the accent is a separate combining mark, so folded and original
    // offsets diverge. The highlight must still cover the visible word.
    const decomposed = 'Re\u0301sume\u0301 total';
    const [match] = findMatches([item(decomposed)], 'resume');
    expect(match).toBeDefined();
    const covered = decomposed.slice(match?.start ?? 0, match?.end ?? 0);
    expect(covered.normalize('NFC')).toBe('Résumé');
  });

  it('returns nothing for an empty or whitespace query', () => {
    expect(findMatches([item('anything')], '')).toEqual([]);
    expect(findMatches([item('anything')], '   ')).toEqual([]);
  });

  it('does not match across item boundaries', () => {
    // Two separate positioned runs are not one string; a match spanning them
    // would highlight a region the viewer never sees as contiguous.
    expect(findMatches([item('reve'), item('nue')], 'revenue')).toEqual([]);
  });
});

describe('splitRuns', () => {
  it('preserves the original text exactly', () => {
    const text = 'revenue and revenue';
    const matches = findMatches([item(text)], 'revenue');
    const runs = splitRuns(text, matches, 0);
    expect(runs.map((run) => run.text).join('')).toBe(text);
    expect(runs.filter((run) => run.matched)).toHaveLength(2);
  });

  it('marks each match with its global index so the current match can differ', () => {
    const matches = findMatches([item('a'), item('xx')], 'x');
    const runs = splitRuns('xx', matches, 1);
    expect(runs.filter((run) => run.matched).map((run) => run.matchIndex)).toEqual([0, 1]);
  });

  it('returns one unmatched run when the item has no match', () => {
    expect(splitRuns('quiet', [], 0)).toEqual([
      { text: 'quiet', matched: false, matchIndex: null },
    ]);
  });

  it('keeps text intact when a match sits at the very end', () => {
    const text = 'total revenue';
    const runs = splitRuns(text, findMatches([item(text)], 'revenue'), 0);
    expect(runs.map((run) => run.text).join('')).toBe(text);
    expect(runs.at(-1)?.matched).toBe(true);
  });
});
