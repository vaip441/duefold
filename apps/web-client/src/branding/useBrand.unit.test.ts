import { describe, expect, it } from 'vitest';
import { customAccentTokenCss } from './useBrand.ts';

function channel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}
function luminance(value: string): number {
  const raw = value.slice(1);
  const [red = 0, green = 0, blue = 0] = [0, 2, 4].map((offset) =>
    channel(Number.parseInt(raw.slice(offset, offset + 2), 16)),
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}
function contrast(first: string, second: string): number {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return ((values[0] ?? 0) + 0.05) / ((values[1] ?? 0) + 0.05);
}
function block(css: string, selector: string): string {
  const start = css.indexOf(selector);
  return css.slice(start, css.indexOf('\n}', start));
}
function token(css: string, name: string): string {
  const match = new RegExp(`${name}: (#[0-9a-f]{6})`, 'u').exec(css);
  if (match?.[1] === undefined) throw new Error(`missing ${name}`);
  return match[1];
}

describe('custom accent tokens', () => {
  it.each(['#08766a', '#806500', '#75457d'])('%s stays readable in both themes', (accent) => {
    const css = customAccentTokenCss(accent);
    const light = block(css, ':root {');
    const dark = block(css, ":root[data-theme='dark'] {");
    const system = block(css, ':root:not([data-theme]) {');
    for (const [tokens, ground] of [
      [light, '#f2f3f1'],
      [dark, '#161a18'],
      [system, '#161a18'],
    ] as const) {
      expect(contrast(token(tokens, '--accent'), ground)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(token(tokens, '--accent-strong'), ground)).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(token(tokens, '--accent-contrast'), token(tokens, '--accent')),
      ).toBeGreaterThanOrEqual(4.5);
    }
    for (const name of ['--accent', '--accent-strong', '--accent-contrast'])
      expect(token(system, name)).toBe(token(dark, name));
    expect(css).not.toContain('color-mix');
  });
});
