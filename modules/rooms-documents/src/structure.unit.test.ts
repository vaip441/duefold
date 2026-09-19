import { describe, expect, it } from 'vitest';
import {
  MAX_STRUCTURE_DESCRIPTION_LENGTH,
  fractionalOrderKey,
  validateStructureDescription,
  validateStructureName,
} from './structure.ts';

describe('room structure normalization', () => {
  it.each([
    '投資家向け資料',
    'Résumé financier (2026)',
    'Доходы 2026 (финал)',
    'Q4 2026 – Actuals',
    `${'長'.repeat(190)} (1)`,
  ])('accepts legitimate investor document name %s', (name) => {
    expect(() => {
      validateStructureName(name);
    }).not.toThrow();
  });

  it('accepts legitimate distinct names without restricting the character repertoire', () => {
    expect(() => {
      validateStructureName('資料 A');
      validateStructureName('資料 B');
      validateStructureName('Straße');
    }).not.toThrow();
  });

  it('generates stable fractional keys and requests a bounded rebalance only when exhausted', () => {
    expect(fractionalOrderKey(undefined, undefined)).toBe(1024);
    expect(fractionalOrderKey(1024, 2048)).toBe(1536);
    expect(fractionalOrderKey(2048, undefined)).toBe(3072);
    expect(() => {
      fractionalOrderKey(1, 1);
    }).toThrow('ORDER_BOUNDS_INVALID');
  });

  it('counts supplementary-plane characters as code points at exact boundaries', () => {
    const astral = '\u{20BB7}';
    expect(() => {
      validateStructureName(astral.repeat(200));
    }).not.toThrow();
    expect(() => {
      validateStructureName(astral.repeat(201));
    }).toThrow('STRUCTURE_NAME_REJECTED');
    expect(() => {
      validateStructureDescription(astral.repeat(4000));
    }).not.toThrow();
    expect(() => {
      validateStructureDescription(astral.repeat(4001));
    }).toThrow('STRUCTURE_DESCRIPTION_REJECTED');
  });

  it('accepts bounded plain text and rejects control characters without banning markup punctuation', () => {
    expect(() => {
      validateStructureDescription(
        'Revenue < target; see https://example.com/investors\nSecond line',
      );
    }).not.toThrow();
    expect(() => {
      validateStructureDescription('x'.repeat(MAX_STRUCTURE_DESCRIPTION_LENGTH));
    }).not.toThrow();
    expect(() => {
      validateStructureDescription('unsafe\u0000text');
    }).toThrow('STRUCTURE_DESCRIPTION_REJECTED');
  });
});
