/**
 * Accessibility checks with axe-core on every surface this build ships.
 *
 * An axe pass is NOT an accessibility guarantee. It detects a subset of WCAG
 * failures mechanically and cannot judge focus order sensibility, copy clarity,
 * meaningful sequence, or whether a live-region announcement is useful. The
 * criteria it verifies here and the ones still needing human review are recorded
 * in DESIGN.md; the keyboard suite covers operation, and the human-review list is
 * reported rather than implied to be covered.
 *
 * Zero violations is the bar, in both themes, at desktop and 320px.
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { startTestServer, type TestServer } from '../support/browser-server.ts';

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  await server.close();
});

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function scan(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  // Report the rule ids rather than the raw object, so a failure names the
  // criterion instead of dumping a DOM tree.
  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.length,
    })),
  ).toEqual([]);
}

async function useTheme(page: Page, theme: 'light' | 'dark' | 'system'): Promise<void> {
  const control = page.getByLabel('Appearance');
  if (!(await control.isVisible())) await page.getByRole('button', { name: 'Menu' }).click();
  await control.selectOption(theme);
}

async function signInViewer(page: Page, email: string): Promise<void> {
  await server.inviteViewer(email);
  await page.goto(`${server.baseUrl}/read`);
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('Eight-digit code').fill(await server.deliveredCode(email));
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page.getByRole('navigation', { name: 'Collection' })).toBeVisible();
}

test.describe('member sign-in surface', () => {
  test('has no violations in light and dark', async ({ page }) => {
    await page.goto(server.baseUrl);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await useTheme(page, 'light');
    await scan(page);
    await useTheme(page, 'dark');
    await scan(page);
  });

  test('has no violations in the failure state', async ({ page }) => {
    await page.goto(`${server.baseUrl}/sign-in?state=failed`);
    await expect(page.getByRole('alert')).toBeVisible();
    await scan(page);
    await useTheme(page, 'dark');
    await scan(page);
  });
});

test.describe('viewer OTP surfaces', () => {
  test('has no violations at the address step, including its validation state', async ({
    page,
  }) => {
    await page.goto(`${server.baseUrl}/read`);
    await scan(page);
    await page.getByLabel('Email address').fill('not-an-address');
    await page.getByRole('button', { name: 'Send code' }).click();
    await expect(page.getByText('Enter an email address')).toBeVisible();
    await scan(page);
    await useTheme(page, 'dark');
    await scan(page);
  });

  test('has no violations at the code step and its rejection state', async ({ page }) => {
    const email = 'axe-code@example.com';
    await server.inviteViewer(email);
    await page.goto(`${server.baseUrl}/read`);
    await page.getByLabel('Email address').fill(email);
    await page.getByRole('button', { name: 'Send code' }).click();
    await expect(page.getByLabel('Eight-digit code')).toBeVisible();
    await scan(page);
    await page.getByLabel('Eight-digit code').fill('00000000');
    await page.getByRole('button', { name: 'Verify code' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await scan(page);
    await useTheme(page, 'dark');
    await scan(page);
  });

  test('has no violations in the locked state', async ({ page }) => {
    const email = 'axe-locked@example.com';
    await server.inviteViewer(email);
    await page.goto(`${server.baseUrl}/read`);
    await page.getByLabel('Email address').fill(email);
    await page.getByRole('button', { name: 'Send code' }).click();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await page.getByLabel('Eight-digit code').fill(String(attempt).repeat(8));
      await page.getByRole('button', { name: 'Verify code' }).click();
    }
    await expect(page.getByText('Too many attempts for this code')).toBeVisible();
    await scan(page);
  });
});

test.describe('application shell', () => {
  test('has no violations signed in, in light and dark', async ({ page }) => {
    await signInViewer(page, 'axe-shell@example.com');
    await useTheme(page, 'light');
    await scan(page);
    await useTheme(page, 'dark');
    await scan(page);
  });

  test('has no violations with the narrow-viewport index collapsed', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await signInViewer(page, 'axe-narrow@example.com');
    await scan(page);
    // The disclosure exists only at this width, and it must be present: a
    // conditional check here would silently stop testing the collapsed state.
    const toggle = page.getByRole('button', { name: 'Collection' });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await scan(page);
  });
});

test.describe('structural landmarks', () => {
  test('exposes one main, one h1, and named regions', async ({ page }) => {
    await signInViewer(page, 'axe-landmarks@example.com');
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('navigation', { name: 'Collection' })).toHaveCount(1);
    await expect(page.getByRole('complementary', { name: 'Access notes' })).toHaveCount(1);
    // The shell has no footer; counterparties belong to the member Access surface only.
    await expect(page.getByRole('contentinfo')).toHaveCount(0);
    await expect(page.getByRole('banner', { name: 'Room' })).toHaveCount(1);
    await expect(page.getByRole('status')).toHaveCount(1);
  });

  test('keeps the auth surfaces to one main and one h1', async ({ page }) => {
    await page.goto(`${server.baseUrl}/read`);
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  });
});
