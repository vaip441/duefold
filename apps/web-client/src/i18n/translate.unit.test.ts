import { describe, expect, it } from 'vitest';
import { translateCount } from './translate.ts';

describe('counted messages', () => {
  it('uses the singular form for exactly one', () => {
    expect(translateCount('settings.retention.years', 1, { years: 1 })).toBe('1 year');
    expect(translateCount('settings.retention.years', 7, { years: 7 })).toBe('7 years');
    expect(translateCount('status.processing.failed', 1)).toMatch(
      /^1 document version failed/u,
    );
    expect(translateCount('status.processing.failed', 0)).toMatch(/^0 document versions/u);
  });
});
