/**
 * Responsive layout and designed non-happy states.
 *
 * Duefold requires a responsive viewer experience from 320 CSS pixels
 * and a designed state for every route's loading, empty, denied, failure, and
 * offline conditions. These assert the states exist and are readable, not merely
 * that a component renders.
 */

import { expect, test } from '@playwright/test';
import { startTestServer, type TestServer } from '../support/browser-server.ts';

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  await server.close();
});

const WIDTHS = [320, 480, 768, 1024, 1440] as const;

test.describe('responsive layout', () => {
  for (const width of WIDTHS) {
    test(`the sign-in sheet fits ${width}px without horizontal scroll`, async ({ page }) => {
      await page.setViewportSize({ width, height: 780 });
      await page.goto(`${server.baseUrl}/read`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const organization = page.getByText('Northwind Capital', { exact: true });
      await expect(organization).toHaveText('Northwind Capital');
      if (width <= 480) {
        const box = await organization.boundingBox();
        expect(box?.width ?? 0).toBeGreaterThan(0);
      }
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      // A viewer must never have to scroll sideways to read or type.
      expect(overflow).toBeLessThanOrEqual(1);
      // The primary action stays within the viewport.
      const action = await page.getByRole('button', { name: 'Send code' }).boundingBox();
      expect(action?.x ?? 0).toBeGreaterThanOrEqual(0);
      expect((action?.x ?? 0) + (action?.width ?? 0)).toBeLessThanOrEqual(width + 1);
    });
  }

  test('restacks the shell into one column at 320px rather than scaling down', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 780 });
    const email = 'responsive-shell@example.com';
    await server.inviteViewer(email);
    await page.goto(`${server.baseUrl}/read`);
    await page.getByLabel('Email address').fill(email);
    await page.getByRole('button', { name: 'Send code' }).click();
    await page.getByLabel('Eight-digit code').fill(await server.deliveredCode(email));
    await page.getByRole('button', { name: 'Verify code' }).click();
    await expect(page.getByRole('navigation', { name: 'Collection' })).toBeVisible();
    await expect(page.getByText('Northwind Capital', { exact: true })).toBeVisible();
    await expect(page.getByText('Northwind Capital', { exact: true })).toHaveText(
      'Northwind Capital',
    );
    const menu = page.getByRole('button', { name: 'Menu' });
    await expect(menu).toBeVisible();
    await expect(page.getByLabel('Appearance')).not.toBeVisible();
    await menu.click();
    await expect(page.getByLabel('Appearance')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('Appearance')).not.toBeVisible();
    await expect(menu).toBeFocused();
    await menu.click();
    await page.getByRole('heading', { level: 1 }).click();
    await expect(page.getByLabel('Appearance')).not.toBeVisible();

    const factsHeight = await page
      .locator('.df-facts')
      .evaluate((element) => element.getBoundingClientRect().height);
    // Supported phone widths use a deliberate identity row and compact action
    // row, not the old multi-line control stack.
    expect(factsHeight).toBeLessThan(120);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    // One column: the index and worktable start at the same inline offset,
    // rather than sitting side by side in a squeezed two-column grid.
    const boxes = await page.evaluate(() => {
      const index = document.querySelector('.df-index')?.getBoundingClientRect();
      const worktable = document.querySelector('.df-worktable')?.getBoundingClientRect();
      return index === undefined || worktable === undefined
        ? null
        : {
            indexLeft: index.left,
            worktableLeft: worktable.left,
            indexTop: index.top,
            worktableTop: worktable.top,
          };
    });
    expect(boxes?.indexLeft).toBe(boxes?.worktableLeft);
    expect(boxes?.worktableTop ?? 0).toBeGreaterThan(boxes?.indexTop ?? 0);
  });

  test('keeps the three-region layout at desktop width', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const email = 'responsive-desktop@example.com';
    await server.inviteViewer(email);
    await page.goto(`${server.baseUrl}/read`);
    await page.getByLabel('Email address').fill(email);
    await page.getByRole('button', { name: 'Send code' }).click();
    await page.getByLabel('Eight-digit code').fill(await server.deliveredCode(email));
    await page.getByRole('button', { name: 'Verify code' }).click();
    await expect(page.getByRole('navigation', { name: 'Collection' })).toBeVisible();

    const boxes = await page.evaluate(() => {
      const index = document.querySelector('.df-index')?.getBoundingClientRect();
      const worktable = document.querySelector('.df-worktable')?.getBoundingClientRect();
      const notes = document.querySelector('.df-notes')?.getBoundingClientRect();
      return index === undefined || worktable === undefined || notes === undefined
        ? null
        : { index: index.left, worktable: worktable.left, notes: notes.left };
    });
    // Index, worktable, notes read left to right on one plane.
    expect(boxes?.index ?? 0).toBeLessThan(boxes?.worktable ?? 0);
    expect(boxes?.worktable ?? 0).toBeLessThan(boxes?.notes ?? 0);
  });

  test('meets the 24px minimum target size for controls', async ({ page }) => {
    // WCAG 2.2 2.5.8 Target Size (Minimum).
    await page.setViewportSize({ width: 320, height: 780 });
    await page.goto(`${server.baseUrl}/read`);
    await expect(page.getByRole('button', { name: 'Send code' })).toBeVisible();
    const buttons = await page.getByRole('button').all();
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      const box = await button.boundingBox();
      if (box === null) continue;
      expect(box.height, 'control height').toBeGreaterThanOrEqual(24);
      expect(box.width, 'control width').toBeGreaterThanOrEqual(24);
    }
  });
});

test.describe('designed failure states', () => {
  test('shows an offline state with a retry rather than a blank page', async ({ page }) => {
    // Fail the bootstrap the way a dropped connection does.
    await page.route('**/api/auth/session', (route) => route.abort('failed'));
    await page.goto(server.baseUrl);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('No connection');
    await expect(page.getByRole('alert')).toContainText('Your browser is offline');
    await expect(page.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  test('recovers when the connection returns', async ({ page }) => {
    let fail = true;
    await page.route('**/api/auth/session', async (route) => {
      if (fail) {
        await route.abort('failed');
        return;
      }
      await route.continue();
    });
    await page.goto(server.baseUrl);
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    fail = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  });

  test('shows an unavailable state when the server errors', async ({ page }) => {
    await page.route('**/api/auth/session', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'INTERNAL', message: 'The request could not be completed.' },
        }),
      }),
    );
    await page.goto(server.baseUrl);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'The service is not responding',
    );
    // No internal code reaches the page even though the response carried one.
    const body = await page.locator('body').innerText();
    expect(body).not.toContain('INTERNAL');
    expect(body).not.toContain('500');
  });

  test('shows the rate-limited state without revealing which limit was hit', async ({
    page,
  }) => {
    await page.route('**/api/auth/otp/request', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'RATE_LIMITED', message: 'Please wait before trying again.' },
        }),
      }),
    );
    await page.goto(`${server.baseUrl}/read`);
    await page.getByLabel('Email address').fill('rate-limited@example.com');
    await page.getByRole('button', { name: 'Send code' }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Too many code requests');
    // Nothing about the address, and nothing distinguishing cooldown from limit.
    await expect(alert).not.toContainText('invited');
    await expect(alert).not.toContainText('RATE_LIMITED');
  });

  test('a missing API route stays JSON and never returns the app shell', async ({ page }) => {
    const response = await page.request.get(`${server.baseUrl}/api/does-not-exist`);
    expect(response.status()).toBe(404);
    expect(response.headers()['content-type']).toContain('application/json');
    expect(await response.text()).not.toContain('<!doctype');
  });

  test('a client-side route loads the shell directly', async ({ page }) => {
    const response = await page.goto(`${server.baseUrl}/read/some/deep/path`);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });
});

test.describe('theme handling', () => {
  test('an individual override changes the ground in every browser', async ({ page }) => {
    // Product logic, independent of any media-query emulation.
    await page.goto(server.baseUrl);
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/u);
    await page.getByLabel('Appearance').selectOption('light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const light = await page.evaluate(
      () => window.getComputedStyle(document.body).backgroundColor,
    );
    await page.getByLabel('Appearance').selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const dark = await page.evaluate(
      () => window.getComputedStyle(document.body).backgroundColor,
    );
    expect(dark).not.toBe(light);
    // Returning to System removes the override rather than pinning a value.
    await page.getByLabel('Appearance').selectOption('system');
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/u);
  });

  test('the system default follows prefers-color-scheme', async ({ browser }) => {
    const context = await browser.newContext({
      colorScheme: 'dark',
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    await page.goto(server.baseUrl);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const emulated = await page.evaluate(
      () => window.matchMedia('(prefers-color-scheme: dark)').matches,
    );
    // Firefox under this Playwright build does not apply colorScheme emulation,
    // so the media query reports light regardless of the context option. Skip
    // rather than assert something the harness cannot set up; the override test
    // above still covers the dark tokens themselves.
    test.skip(!emulated, 'browser did not apply prefers-color-scheme emulation');
    // No explicit attribute: the media query supplies the dark ground.
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/u);
    const systemGround = await page.evaluate(
      () => window.getComputedStyle(document.body).backgroundColor,
    );
    await page.getByLabel('Appearance').selectOption('light');
    const overridden = await page.evaluate(
      () => window.getComputedStyle(document.body).backgroundColor,
    );
    // An individual override wins over the system preference.
    expect(overridden).not.toBe(systemGround);
    await context.close();
  });

  test('retains an individual override across refreshes', async ({ page }) => {
    await page.goto(server.baseUrl);
    await page.getByLabel('Appearance').selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect
      .poll(() => page.evaluate(() => window.localStorage.getItem('duefold.theme')))
      .toBe('dark');

    await page.reload();
    await expect(page.getByLabel('Appearance')).toHaveValue('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.getByLabel('Appearance').selectOption('system');
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/u);
    await expect
      .poll(() => page.evaluate(() => window.localStorage.getItem('duefold.theme')))
      .toBeNull();
    expect(await page.evaluate(() => window.sessionStorage.length)).toBe(0);
  });

  test('ignores an invalid stored theme choice', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('duefold.theme', 'sepia');
    });
    await page.goto(server.baseUrl);
    await expect(page.getByLabel('Appearance')).toHaveValue('system');
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/u);
  });
});
