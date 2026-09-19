import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { RIBBON_BOWL_PATH, RIBBON_COLORS, RIBBON_STEM_PATH } from '@duefold/shared/brand-mark';
import { DUEFOLD_WORDMARK_OUTLINE } from './brand-wordmark.ts';

const PUBLIC_DIR = 'apps/web-client/public';
const BRAND_DIR = path.join(PUBLIC_DIR, 'brand');
fs.mkdirSync(BRAND_DIR, { recursive: true });

function themeStyle(theme: 'responsive' | 'light' | 'dark' = 'responsive'): string {
  const colors = theme === 'dark' ? RIBBON_COLORS.dark : RIBBON_COLORS.light;
  const responsive =
    theme === 'responsive'
      ? `
  @media(prefers-color-scheme:dark){
    .df-brand-art{color:${RIBBON_COLORS.dark.stem}}
    .df-ribbon-stem{fill:${RIBBON_COLORS.dark.stem}}
    .df-ribbon-bowl{fill:${RIBBON_COLORS.dark.bowl}}
  }`
      : '';
  return `<style>
  .df-brand-art{color:${colors.stem}}
  .df-ribbon-stem{fill:${colors.stem}}
  .df-ribbon-bowl{fill:${colors.bowl}}${responsive}
</style>`;
}

function ribbonPaths(): string {
  return `<path class="df-ribbon-stem" d="${RIBBON_STEM_PATH}"/>
  <path class="df-ribbon-bowl" d="${RIBBON_BOWL_PATH}"/>`;
}

export function markResponsiveSVG(): string {
  return `<svg class="df-brand-art" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none">
  ${themeStyle()}
  ${ribbonPaths()}
</svg>`;
}

/**
 * The outlined wordmark is 22 units high. The Ribbon's 24-unit drawn height is
 * scaled to 19.8 units (0.9 × 22). After accounting for the 32-unit mark
 * viewBox's trailing clear area, the visible gap is 6.16 units (0.28 × 22).
 * Both are optically centred in the 32-unit lockup.
 */
export function logoSVG(theme: 'responsive' | 'light' | 'dark' = 'responsive'): string {
  return `<svg class="df-brand-art" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 107 32" role="img" aria-label="Duefold">
  ${themeStyle(theme)}
  <g transform="translate(-4.95 2.8) scale(.825)">${ribbonPaths()}</g>
  <g fill="currentColor" transform="translate(21.89 23.986) scale(.022)">
    ${DUEFOLD_WORDMARK_OUTLINE.trim()}
  </g>
</svg>`;
}

interface IcoImage {
  readonly size: 16 | 32;
  readonly png: Buffer;
}

function createIco(images: readonly IcoImage[]): Buffer {
  const directory = Buffer.alloc(6 + images.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(images.length, 4);
  let offset = directory.length;
  images.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16;
    directory.writeUInt8(size, entry);
    directory.writeUInt8(size, entry + 1);
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([directory, ...images.map(({ png }) => png)]);
}

async function rasterizedMark(page: Page, size: 16 | 32): Promise<Buffer> {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>*{box-sizing:border-box}body{margin:0;width:${String(size)}px;height:${String(size)}px}svg{display:block;width:100%;height:100%}</style>${markResponsiveSVG()}`,
  );
  return page.locator('svg').screenshot({ omitBackground: true });
}

export async function generateAllAssets(): Promise<void> {
  fs.writeFileSync(path.join(BRAND_DIR, 'brand-mark.svg'), markResponsiveSVG());
  fs.writeFileSync(path.join(BRAND_DIR, 'logo.svg'), logoSVG());
  fs.writeFileSync(path.join(BRAND_DIR, 'logo-light.svg'), logoSVG('light'));
  fs.writeFileSync(path.join(BRAND_DIR, 'logo-dark.svg'), logoSVG('dark'));
  fs.writeFileSync(path.join(PUBLIC_DIR, 'favicon.svg'), markResponsiveSVG());

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ colorScheme: 'light' });
    await page.setViewportSize({ width: 180, height: 180 });
    await page.setContent(
      `<style>*{box-sizing:border-box}body{margin:0;width:180px;height:180px;background:#f2f3f1;display:grid;place-items:center}svg{width:108px;height:108px}</style>${markResponsiveSVG()}`,
    );
    fs.writeFileSync(
      path.join(PUBLIC_DIR, 'apple-touch-icon.png'),
      await page.screenshot({ clip: { x: 0, y: 0, width: 180, height: 180 } }),
    );

    fs.writeFileSync(
      path.join(PUBLIC_DIR, 'favicon.ico'),
      createIco([
        { size: 16, png: await rasterizedMark(page, 16) },
        { size: 32, png: await rasterizedMark(page, 32) },
      ]),
    );

    const sans = fs
      .readFileSync(
        'node_modules/@fontsource-variable/public-sans/files/public-sans-latin-wght-normal.woff2',
      )
      .toString('base64');
    await page.setViewportSize({ width: 1280, height: 640 });
    await page.setContent(`<!doctype html><style>
      @font-face{font-family:Sans;src:url(data:font/woff2;base64,${sans})}
      *{box-sizing:border-box}body{margin:0;width:1280px;height:640px;background:#f2f3f1;color:#1b211f;display:grid;place-items:center;font-family:Sans}
      main{width:1160px;height:520px;border:1px solid #c7cdc7;background:#f7f8f6;display:grid;place-items:center;text-align:center;align-content:center;gap:28px;position:relative}
      .lockup{width:420px}.lockup svg{display:block;width:100%;height:auto}.description{font-size:22px;color:#555f58;max-width:62ch;margin:0;text-wrap:balance}.tag{position:absolute;top:24px;left:32px;font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:#616a63}
    </style><main><span class="tag">Self-hosted investor data room</span><div class="lockup">${logoSVG()}</div><p class="description">Share investor documents with named readers, explicit publication, and simple permissions — on infrastructure you control.</p></main>`);
    const socialPreview = await page.screenshot({
      clip: { x: 0, y: 0, width: 1280, height: 640 },
    });
    fs.writeFileSync(path.join(BRAND_DIR, 'social-preview.png'), socialPreview);
  } finally {
    await browser.close();
  }
}

await generateAllAssets();
