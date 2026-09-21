import { describe, expect, it } from 'vitest';
import { readForSection } from './useLoad.ts';

describe('readForSection', () => {
  it('returns loading when read is null', () => {
    expect(readForSection(null, 1)).toStrictEqual({ kind: 'loading' });
  });

  it('returns loading when keys do not match', () => {
    expect(
      readForSection({ key: 1, load: { kind: 'ready', value: 'hello' }, failure: null }, 2),
    ).toStrictEqual({ kind: 'loading' });
  });

  it('returns the load when keys match', () => {
    expect(
      readForSection({ key: 2, load: { kind: 'ready', value: 'hello' }, failure: null }, 2),
    ).toStrictEqual({ kind: 'ready', value: 'hello' });
  });
});
