import { existsSync, readFileSync } from 'node:fs';
import { RIBBON_BOWL_PATH, RIBBON_STEM_PATH } from '@duefold/shared/brand-mark';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const PUBLIC_DIR = resolve(import.meta.dirname, '../public');
const BRAND_DIR = resolve(PUBLIC_DIR, 'brand');

describe('brand assets', () => {
  it('provides compact responsive and fixed-theme logo lockups', () => {
    const mark = readFileSync(resolve(BRAND_DIR, 'brand-mark.svg'), 'utf8');
    expect(mark).toContain('viewBox="0 0 32 32"');
    expect(mark).toContain(RIBBON_STEM_PATH);
    expect(mark).toContain(RIBBON_BOWL_PATH);
    expect(mark).toContain('prefers-color-scheme:dark');

    const logoPath = resolve(BRAND_DIR, 'logo.svg');
    const logo = readFileSync(logoPath, 'utf8');
    expect(Buffer.byteLength(logo)).toBeLessThan(6_000);
    expect(logo).toContain('aria-label="Duefold"');
    expect(logo).toContain(RIBBON_STEM_PATH);
    expect(logo).toContain(RIBBON_BOWL_PATH);
    expect(logo).toContain('prefers-color-scheme:dark');
    expect(logo).not.toContain('<text');
    expect(logo).not.toContain('font-family');
    expect(logo).not.toContain('data:font');
    const lightLogo = readFileSync(resolve(BRAND_DIR, 'logo-light.svg'), 'utf8');
    const darkLogo = readFileSync(resolve(BRAND_DIR, 'logo-dark.svg'), 'utf8');
    expect(lightLogo).not.toContain('prefers-color-scheme:dark');
    expect(darkLogo).not.toContain('prefers-color-scheme:dark');
    expect(lightLogo).toContain('#1b211f');
    expect(darkLogo).toContain('#e8ebe7');
    const readme = readFileSync(resolve(import.meta.dirname, '../../../README.md'), 'utf8');
    expect(readme).toContain('brand/logo-light.svg');
    expect(readme).toContain('brand/logo-dark.svg');
  });

  it('provides root favicon and touch icon assets without duplicate brand copies', () => {
    const faviconPath = resolve(PUBLIC_DIR, 'favicon.svg');
    const favicon = readFileSync(faviconPath, 'utf8');
    expect(favicon).toContain('prefers-color-scheme:dark');
    expect(favicon).toContain(RIBBON_STEM_PATH);
    expect(favicon).toContain(RIBBON_BOWL_PATH);
    const ico = readFileSync(resolve(PUBLIC_DIR, 'favicon.ico'));
    expect(ico.readUInt16LE(4)).toBe(2);
    expect([ico.readUInt8(6), ico.readUInt8(22)]).toEqual([16, 32]);
    const touch = readFileSync(resolve(PUBLIC_DIR, 'apple-touch-icon.png'));
    expect(touch.subarray(0, 4).toString('hex')).toBe('89504e47');
    for (const duplicate of [
      'brand-mark-light.svg',
      'brand-mark-dark.svg',
      'favicon.svg',
      'favicon.ico',
      'apple-touch-icon.png',
    ])
      expect(existsSync(resolve(BRAND_DIR, duplicate)), duplicate).toBe(false);
  });

  it('provides the 1280x640 social preview', () => {
    const buffer = readFileSync(resolve(BRAND_DIR, 'social-preview.png'));
    expect(buffer.readUInt32BE(16)).toBe(1280);
    expect(buffer.readUInt32BE(20)).toBe(640);
  });
});
