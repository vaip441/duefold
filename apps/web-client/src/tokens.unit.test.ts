/**
 * Design-system token tests.
 *
 * These assert the properties the Reading Room direction rests on, so a later
 * edit that quietly reintroduces card styling, a second accent, or a failing
 * contrast pair breaks a test rather than shipping.
 *
 * Contrast is computed here rather than trusted from a comment: WCAG 2.2 1.4.3
 * and 1.4.11 are arithmetic, and the arithmetic belongs in the suite.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const STYLE_DIR = resolve(import.meta.dirname, 'styles');

function style(name: string): string {
  return readFileSync(resolve(STYLE_DIR, name), 'utf8');
}

const tokens = style('tokens.css');
const shell = style('shell.css');
const components = style('components.css');
const base = style('base.css');
const allStyles = `${tokens}\n${shell}\n${components}\n${base}`;

/** Reads a custom property from a specific block of the token file. */
function tokenValue(block: string, name: string): string {
  const blockStart = tokens.indexOf(block);
  if (blockStart < 0) throw new Error(`token block missing: ${block}`);
  const blockBody = tokens.slice(blockStart, tokens.indexOf('\n}', blockStart));
  const match = new RegExp(`${name}:\\s*([^;]+);`, 'u').exec(blockBody);
  if (match?.[1] === undefined) throw new Error(`token missing in ${block}: ${name}`);
  return match[1].trim();
}

function channel(value: number): number {
  const ratio = value / 255;
  return ratio <= 0.04045 ? ratio / 12.92 : Math.pow((ratio + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const normalized = hex.trim().replace('#', '');
  if (!/^[0-9a-f]{6}$/iu.test(normalized)) throw new Error(`not a hex colour: ${hex}`);
  const [red, green, blue] = [0, 2, 4].map((offset) =>
    channel(Number.parseInt(normalized.slice(offset, offset + 2), 16)),
  );
  if (red === undefined || green === undefined || blue === undefined)
    throw new Error('colour parse failed');
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

const THEMES = ['light', 'dark'] as const;
const BLOCK: Readonly<Record<(typeof THEMES)[number], string>> = {
  light: ':root {',
  dark: ":root[data-theme='dark'] {",
};

describe('token contrast', () => {
  /** 1.4.3: body text needs 4.5:1 against every ground it is used on. */
  it.each(THEMES)('%s text tokens meet 4.5:1 on both grounds', (theme) => {
    const block = BLOCK[theme];
    const grounds = ['--ground', '--ground-sunken'].map((name) => tokenValue(block, name));
    for (const inkToken of ['--ink', '--ink-muted', '--ink-faint']) {
      const ink = tokenValue(block, inkToken);
      for (const ground of grounds) {
        expect(
          contrastRatio(ink, ground),
          `${theme} ${inkToken} on ${ground}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it.each(THEMES)('%s accent and status tokens meet 4.5:1 on both grounds', (theme) => {
    const block = BLOCK[theme];
    const grounds = ['--ground', '--ground-sunken'].map((name) => tokenValue(block, name));
    for (const token of ['--accent', '--accent-strong', '--danger', '--notice']) {
      const value = tokenValue(block, token);
      for (const ground of grounds) {
        expect(
          contrastRatio(value, ground),
          `${theme} ${token} on ${ground}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it.each(THEMES)('%s primary button text meets 4.5:1 on the accent fill', (theme) => {
    const block = BLOCK[theme];
    expect(
      contrastRatio(tokenValue(block, '--accent-contrast'), tokenValue(block, '--accent')),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it('generates custom tokens for light, explicit dark, and system dark', () => {
    const implementation = readFileSync(
      resolve(import.meta.dirname, 'branding/useBrand.ts'),
      'utf8',
    );
    expect(implementation).toContain('@media (prefers-color-scheme: dark)');
    expect(implementation).toContain(':root:not([data-theme])');
  });

  /** 1.4.11: control boundaries and focus indication need 3:1. */
  it.each(THEMES)('%s control border and focus ring meet 3:1', (theme) => {
    const block = BLOCK[theme];
    const ground = tokenValue(block, '--ground');
    expect(contrastRatio(tokenValue(block, '--rule-strong'), ground)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(tokenValue(block, '--accent'), ground)).toBeGreaterThanOrEqual(3);
  });
});

describe('Reading Room discipline', () => {
  it('declares exactly one accent hue per theme', () => {
    // --accent, --accent-strong, --accent-contrast, and --accent-wash are roles
    // of one green. A fifth accent token would be a second colour arriving.
    const accentTokens = [...tokens.matchAll(/--accent[\w-]*:/gu)].map(([match]) => match);
    expect(new Set(accentTokens).size).toBe(4);
  });

  it('ships no shadow anywhere: hierarchy comes from rules, not elevation', () => {
    expect(allStyles).not.toMatch(/box-shadow/u);
    expect(allStyles).not.toMatch(/filter:\s*drop-shadow/u);
  });

  it('keeps every radius at or below the 2px control radius', () => {
    expect(tokenValue(':root {', '--radius-control')).toBe('2px');
    // Any literal radius in a component would bypass the token.
    const literalRadii = [...allStyles.matchAll(/border-radius:\s*([^;]+);/gu)].map(
      ([, value]) => value?.trim(),
    );
    for (const radius of literalRadii) {
      expect(radius, 'radius must come from the token').toBe('var(--radius-control)');
    }
  });

  it('keeps the type scale at five sizes', () => {
    const sizes = [...tokens.matchAll(/--size-[\w-]+:/gu)].map(([match]) => match);
    expect(new Set(sizes).size).toBe(5);
  });

  it('sets a dark theme for every colour token the light theme defines', () => {
    const colourTokens = [
      '--ground',
      '--ground-sunken',
      '--ground-raised',
      '--ink',
      '--ink-muted',
      '--ink-faint',
      '--rule',
      '--rule-strong',
      '--accent',
      '--accent-strong',
      '--accent-contrast',
      '--accent-wash',
      '--danger',
      '--notice',
      '--selection-ground',
    ] as const;
    for (const token of colourTokens) {
      expect(() => tokenValue(BLOCK.dark, token), `dark ${token}`).not.toThrow();
    }
  });

  it('mirrors the dark theme into the system-preference block', () => {
    // A half-working dark mode is worse than none: the explicit override and the
    // system default must define the same tokens.
    const systemBlock = tokens.slice(tokens.indexOf('@media (prefers-color-scheme: dark)'));
    for (const token of ['--ground', '--ink', '--accent', '--rule-strong', '--danger']) {
      expect(systemBlock, `system default ${token}`).toContain(`${token}:`);
    }
  });

  it('pins document pixels to a colour-accurate ground in both themes', () => {
    // Document pixels are never theme-inverted.
    const rule = base.slice(base.indexOf('.df-document-pixels'));
    expect(rule).toContain('background: #ffffff');
    expect(rule).toContain('color-scheme: light');
    expect(rule).toContain('forced-color-adjust: none');
  });

  it('self-hosts every font and requests none from a third party', () => {
    expect(tokens).toContain("@import '@fontsource-variable/");
    expect(allStyles).not.toMatch(/https?:\/\//u);
    expect(allStyles).not.toMatch(/fonts\.googleapis|fonts\.gstatic|cdn\./u);
  });
});

describe('motion grammar', () => {
  it('transitions named properties only, never `all`', () => {
    const transitions = [...allStyles.matchAll(/transition:\s*([^;]+);/gu)].map(([, value]) =>
      value?.trim(),
    );
    expect(transitions.length).toBeGreaterThan(0);
    for (const transition of transitions) {
      expect(transition, 'transition must name its properties').not.toMatch(/^all\b/u);
    }
  });

  it('uses no entrance animation, so nothing animates on first paint', () => {
    expect(allStyles).not.toMatch(/@keyframes/u);
    expect(allStyles).not.toMatch(/animation-name/u);
    expect(allStyles).not.toMatch(/@starting-style/u);
  });

  it('keeps every duration under 300ms', () => {
    const durations = [...tokens.matchAll(/--duration-[\w-]+:\s*(\d+)ms;/gu)].map(([, value]) =>
      Number(value),
    );
    expect(durations.length).toBeGreaterThan(0);
    for (const duration of durations) expect(duration).toBeLessThan(300);
  });

  it('honours prefers-reduced-motion', () => {
    expect(base).toContain('@media (prefers-reduced-motion: reduce)');
    const block = base.slice(base.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(block).toContain('transition-duration: 1ms !important');
    expect(block).toContain('animation-duration: 1ms !important');
  });
});

describe('browser surfaces the system is responsible for', () => {
  it('themes selection, focus, and scrollbars from the palette', () => {
    expect(base).toContain('::selection');
    expect(base).toContain('scrollbar-color');
    expect(base).toContain(':focus-visible');
  });

  it('never removes a focus indicator outright', () => {
    // `:focus:not(:focus-visible)` relocating the ring is fine; a bare
    // `outline: none` on a focusable element is not.
    const withoutComments = allStyles.replaceAll(/\/\*[\s\S]*?\*\//gu, '');
    const outlineNone = [...withoutComments.matchAll(/([^{}]+)\{[^{}]*outline:\s*none/gu)].map(
      ([, selector]) => selector?.trim(),
    );
    expect(outlineNone.length).toBeGreaterThan(0);
    for (const selector of outlineNone) {
      expect(selector).toBe(':focus:not(:focus-visible)');
    }
  });

  it('renders aligned data with tabular numerals', () => {
    expect(base).toContain('font-variant-numeric: tabular-nums');
  });
});

describe('responsive structure', () => {
  it('restacks the shell rather than scaling the desktop layout down', () => {
    // Breakpoints change grid-template-areas, not a zoom factor.
    expect(shell).toContain('@media (max-width: 68rem)');
    expect(shell).toContain('@media (max-width: 48rem)');
    const narrow = shell.slice(shell.indexOf('@media (max-width: 48rem)'));
    expect(narrow).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(allStyles).not.toMatch(/zoom:/u);
  });

  it('sizes type in rem so a browser font-size setting scales the interface', () => {
    const fontSizes = [...tokens.matchAll(/--size-[\w-]+:\s*([^;]+);/gu)].map(([, value]) =>
      value?.trim(),
    );
    for (const size of fontSizes) expect(size).toMatch(/rem$/u);
  });
});
