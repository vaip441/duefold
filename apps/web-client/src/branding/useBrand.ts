import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  createElement,
  type ReactNode,
} from 'react';
import { composedBrowserEntries } from 'virtual:duefold/browser-entries';
import type { BrandingSlot, EffectiveBrand } from '../contract.ts';

function getBrandingSlot(): BrandingSlot | null {
  for (const entry of composedBrowserEntries) {
    const slot = entry.contribution.branding;
    if (slot !== undefined) return slot;
  }
  return null;
}

const BRAND_STYLE_ID = 'df-custom-brand-tokens';
const LIGHT_GROUND = '#f2f3f1';
const DARK_GROUND = '#161a18';

function rgb(hex: string): readonly [number, number, number] {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ];
}
function hex(values: readonly number[]): string {
  return `#${values.map((value) => Math.round(value).toString(16).padStart(2, '0')).join('')}`;
}
function mix(first: string, second: string, amount: number): string {
  const a = rgb(first);
  const b = rgb(second);
  return hex(a.map((value, index) => value * (1 - amount) + (b[index] ?? 0) * amount));
}
function luminance(value: string): number {
  const channels = rgb(value).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return (
    0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0)
  );
}
function contrast(first: string, second: string): number {
  const [bright = 0, dark = 0] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (bright + 0.05) / (dark + 0.05);
}
function readableAccent(accent: string, ground: string, toward: '#000000' | '#ffffff'): string {
  for (let step = 0; step <= 100; step += 1) {
    const candidate = mix(accent, toward, step / 100);
    if (contrast(candidate, ground) >= 4.5) return candidate;
  }
  return toward;
}
function foreground(background: string): '#000000' | '#ffffff' {
  return contrast(background, '#ffffff') >= contrast(background, '#000000')
    ? '#ffffff'
    : '#000000';
}
function tokenSet(accent: string, ground: string, dark: boolean): string {
  const accessible = readableAccent(accent, ground, dark ? '#ffffff' : '#000000');
  const strong = readableAccent(
    mix(accessible, dark ? '#ffffff' : '#000000', 0.18),
    ground,
    dark ? '#ffffff' : '#000000',
  );
  return `
  --accent: ${accessible};
  --accent-strong: ${strong};
  --accent-wash: ${mix(ground, accessible, dark ? 0.2 : 0.14)};
  --accent-contrast: ${foreground(accessible)};`;
}

export function customAccentTokenCss(accentHex: string): string {
  const accent = accentHex.toLowerCase();
  const light = tokenSet(accent, LIGHT_GROUND, false);
  const dark = tokenSet(accent, DARK_GROUND, true);
  return `:root {${light}\n}\n:root[data-theme='dark'] {${dark}\n}\n@media (prefers-color-scheme: dark) {\n  :root:not([data-theme]) {${dark}\n  }\n}`;
}

/** Applies only concrete WCAG-safe colours; no browser-dependent color-mix values. */
export function applyAccentTokens(accentHex: string | null): void {
  const existing = document.getElementById(BRAND_STYLE_ID);
  if (!accentHex || !/^#[0-9a-fA-F]{6}$/u.test(accentHex)) {
    existing?.remove();
    return;
  }
  const accent = accentHex.toLowerCase();
  const css = customAccentTokenCss(accent);
  let style = existing as HTMLStyleElement | null;
  if (style === null) {
    style = document.createElement('style');
    style.id = BRAND_STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = css;
}

interface BrandContextValue {
  readonly brand: EffectiveBrand | null;
  readonly reload: () => void;
}
const DEFAULT_BRAND_CONTEXT: BrandContextValue = { brand: null, reload: () => undefined };
const BrandContext = createContext<BrandContextValue>(DEFAULT_BRAND_CONTEXT);
let sharedRequest: Promise<EffectiveBrand | null> | null = null;
let sharedController: AbortController | null = null;

function loadSharedBrand(): Promise<EffectiveBrand | null> {
  if (sharedRequest !== null) return sharedRequest;
  const slot = getBrandingSlot();
  if (slot === null) return Promise.resolve(null);
  sharedController = new AbortController();
  sharedRequest = slot.load(sharedController.signal);
  return sharedRequest;
}

function resetSharedBrand(): void {
  sharedController?.abort();
  sharedController = null;
  sharedRequest = null;
}

function updateFavicon(brand: EffectiveBrand | null): void {
  const icon = document.querySelector<HTMLLinkElement>(
    "link[rel='icon'][type='image/svg+xml']",
  );
  if (icon === null) return;
  icon.href = brand?.squareMarkUrl ?? '/favicon.svg';
}

/** Loads branding once at the application root and shares it with every surface. */
export function BrandProvider({
  children,
}: {
  readonly children: ReactNode;
}): React.ReactElement {
  const [brand, setBrand] = useState<EffectiveBrand | null>(null);
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => {
    resetSharedBrand();
    setGeneration((value) => value + 1);
  }, []);

  useEffect(() => {
    let active = true;
    loadSharedBrand().then(
      (resolved) => {
        if (!active) return;
        setBrand(resolved);
        applyAccentTokens(resolved?.accentColor ?? null);
        updateFavicon(resolved);
      },
      (error: unknown) => {
        if (!active || (error instanceof DOMException && error.name === 'AbortError')) return;
        setBrand(null);
        applyAccentTokens(null);
        updateFavicon(null);
      },
    );
    return () => {
      active = false;
    };
  }, [generation]);

  const value = useMemo(() => ({ brand, reload }), [brand, reload]);
  return createElement(BrandContext.Provider, { value }, children);
}

export function useBrand(): BrandContextValue {
  return useContext(BrandContext);
}
