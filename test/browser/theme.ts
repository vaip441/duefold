/**
 * Waits for a theme change to finish painting before anything measures colour.
 *
 * Buttons and inputs animate `color` and `background-color` over
 * `--duration-state`, so an axe scan issued immediately after
 * `emulateMedia({ colorScheme })` samples colours that are partway between the
 * light and dark tokens. That produced contrast failures citing colours present in
 * neither theme -- `#78817a` on `#161a18`, for example -- and it failed
 * intermittently, which is worse than failing outright: a real contrast regression
 * and a sampling race looked identical.
 *
 * This waits for the transitions to settle rather than lengthening the assertion's
 * tolerance, because the tokens themselves are correct and their measured ratios
 * are recorded in tokens.css. Widening the check would have hidden the very
 * regressions the scan exists to catch.
 */

import type { Page } from '@playwright/test';

export async function settleTheme(page: Page, scheme: 'light' | 'dark'): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  await page.evaluate(
    async () =>
      new Promise<void>((resolve) => {
        // Two frames: one to apply the new token values, one to start the paint.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      }),
  );
  // Then wait out the longest colour transition the design system declares.
  const duration = await page.evaluate(() => {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue('--duration-state')
      .trim();
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : 200;
  });
  await page.waitForTimeout(duration + 80);
}
