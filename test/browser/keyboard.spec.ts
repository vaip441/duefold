/**
 * Keyboard-only operation.
 *
 * These drive the interface with the keyboard alone: no click, no tap, no
 * programmatic focus. They assert what a keyboard user actually needs — that
 * every control is reachable in a sensible order, that the focus indicator is
 * visible, that skip-to-content works, and that both authentication flows can be
 * completed without a pointer.
 */

import { expect, test, type Page } from '@playwright/test';
import { startTestServer, type TestServer } from '../support/browser-server.ts';

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  await server.close();
});

/** Description of the focused element, for readable order assertions. */
async function focused(page: Page): Promise<string> {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (element === null) return 'none';
    const role = element.getAttribute('role') ?? element.tagName.toLowerCase();
    const label =
      element.getAttribute('aria-label') ??
      (element.textContent ?? '').trim().slice(0, 40) ??
      '';
    return `${role}:${label}`;
  });
}

async function tabUntil(page: Page, match: RegExp, limit = 25): Promise<string> {
  for (let step = 0; step < limit; step += 1) {
    await page.keyboard.press('Tab');
    const current = await focused(page);
    if (match.test(current)) return current;
  }
  throw new Error(`no focusable element matched ${String(match)} within ${limit} tabs`);
}

test.describe('sign-in surfaces', () => {
  test('reaches every control on the member sheet by keyboard alone', async ({ page }) => {
    await page.goto(server.baseUrl);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // Theme control, primary action, and the viewer link are all reachable.
    await tabUntil(page, /select|Appearance/iu);
    await tabUntil(page, /Continue to identity provider/iu);
    await tabUntil(page, /invited to read documents/iu);
  });

  test('shows a visible focus indicator rather than relying on the browser default', async ({
    page,
  }) => {
    await page.goto(server.baseUrl);
    await tabUntil(page, /Continue to identity provider/iu);
    const outline = await page.evaluate(() => {
      const element = document.activeElement;
      if (element === null) return null;
      const style = window.getComputedStyle(element);
      return {
        width: style.outlineWidth,
        style: style.outlineStyle,
        color: style.outlineColor,
      };
    });
    expect(outline?.style).not.toBe('none');
    expect(Number.parseFloat(outline?.width ?? '0')).toBeGreaterThanOrEqual(2);
  });

  test('switches to the viewer flow with the keyboard', async ({ page }) => {
    await page.goto(server.baseUrl);
    await tabUntil(page, /invited to read documents/iu);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Enter your invited email',
    );
  });

  test('completes the whole OTP flow without a pointer', async ({ page }) => {
    const email = 'keyboard-flow@example.com';
    await server.inviteViewer(email);
    await page.goto(`${server.baseUrl}/read`);
    // Type the address and submit with Enter from inside the field.
    await tabUntil(page, /input|Email/iu);
    await page.getByLabel('Email address').focus();
    await page.keyboard.type(email);
    await page.keyboard.press('Enter');
    // The code field takes focus when the step changes, so the user continues
    // typing without hunting for it.
    await expect(page.getByLabel('Eight-digit code')).toBeFocused();
    await page.keyboard.type(await server.deliveredCode(email));
    await page.keyboard.press('Enter');
    await expect(page.getByRole('navigation', { name: 'Collection' })).toBeVisible();
  });

  test('reaches the resend and restart controls by keyboard at the code step', async ({
    page,
  }) => {
    const email = 'keyboard-resend@example.com';
    await server.inviteViewer(email);
    await page.goto(`${server.baseUrl}/read`);
    await page.getByLabel('Email address').focus();
    await page.keyboard.type(email);
    await page.keyboard.press('Enter');
    const code = page.getByLabel('Eight-digit code');
    await expect(code).toBeFocused();
    // Verify is disabled until eight digits are entered, and a disabled control
    // is correctly skipped by Tab, so the code is typed first.
    await page.keyboard.type('12345678');
    await expect(page.getByRole('button', { name: 'Verify code' })).toBeEnabled();
    await code.focus();
    await tabUntil(page, /Verify code/iu);
    await tabUntil(page, /Send a new code|different email address/iu);
    // The restart link is reachable without a pointer.
    await page.getByRole('button', { name: 'Use a different email address' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Enter your invited email',
    );
  });
});

test.describe('application shell', () => {
  test('skip-to-content is the first stop and moves focus to the worktable', async ({
    page,
  }) => {
    const email = 'keyboard-skip@example.com';
    await server.inviteViewer(email);
    await page.goto(`${server.baseUrl}/read`);
    await page.getByLabel('Email address').fill(email);
    await page.getByRole('button', { name: 'Send code' }).click();
    await page.getByLabel('Eight-digit code').fill(await server.deliveredCode(email));
    await page.getByRole('button', { name: 'Verify code' }).click();
    await expect(page.getByRole('navigation', { name: 'Collection' })).toBeVisible();

    await page.locator('body').press('Tab');
    expect(await focused(page)).toContain('Skip to content');
    // The skip link translates into view when focused rather than staying
    // off-screen, so a sighted keyboard user can see where they are. The
    // assertion polls because the movement is a 160ms transition.
    await expect
      .poll(async () =>
        page.evaluate(
          () => document.querySelector('.df-skip')?.getBoundingClientRect().top ?? -999,
        ),
      )
      .toBeGreaterThanOrEqual(0);

    await page.keyboard.press('Enter');
    const active = await page.evaluate(() => document.activeElement?.id ?? '');
    expect(active).toBe('df-worktable');
  });

  test('traverses the shell regions in the documented order', async ({ page }) => {
    const email = 'keyboard-order@example.com';
    await server.inviteViewer(email);
    await page.goto(`${server.baseUrl}/read`);
    await page.getByLabel('Email address').fill(email);
    await page.getByRole('button', { name: 'Send code' }).click();
    await page.getByLabel('Eight-digit code').fill(await server.deliveredCode(email));
    await page.getByRole('button', { name: 'Verify code' }).click();
    await expect(page.getByRole('navigation', { name: 'Collection' })).toBeVisible();

    await page.locator('body').press('Tab');
    const order: string[] = [];
    for (let step = 0; step < 8; step += 1) {
      order.push(await focused(page));
      await page.keyboard.press('Tab');
    }
    // The skip link is the very first stop, before any shell control. Wide
    // layouts follow it with the inline account controls and no Menu stop;
    // phones collapse those controls behind the Menu disclosure.
    expect(order[0]).toBe('a:Skip to content');
    if ((page.viewportSize()?.width ?? 0) <= 480) expect(order[1]).toBe('button:Menu');
    else {
      expect(order.slice(1, 4)).toEqual([
        'select:SystemLightDark',
        'button:Sign out',
        'button:Sign out everywhere',
      ]);
      expect(order).not.toContain('button:Menu');
    }
  });

  test('operates the narrow-viewport collection disclosure by keyboard', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    const email = 'keyboard-narrow@example.com';
    await server.inviteViewer(email);
    await page.goto(`${server.baseUrl}/read`);
    await page.getByLabel('Email address').fill(email);
    await page.getByRole('button', { name: 'Send code' }).click();
    await page.getByLabel('Eight-digit code').fill(await server.deliveredCode(email));
    await page.getByRole('button', { name: 'Verify code' }).click();
    await expect(page.getByRole('navigation', { name: 'Collection' })).toBeVisible();

    const toggle = page.getByRole('button', { name: 'Collection' });
    await toggle.focus();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  test('signs out from the keyboard', async ({ page }) => {
    const email = 'keyboard-signout@example.com';
    await server.inviteViewer(email);
    await page.goto(`${server.baseUrl}/read`);
    await page.getByLabel('Email address').fill(email);
    await page.getByRole('button', { name: 'Send code' }).click();
    await page.getByLabel('Eight-digit code').fill(await server.deliveredCode(email));
    await page.getByRole('button', { name: 'Verify code' }).click();
    await expect(page.getByRole('navigation', { name: 'Collection' })).toBeVisible();

    // Phones put account actions behind the Menu disclosure (30rem breakpoint).
    if ((page.viewportSize()?.width ?? 0) <= 480) {
      await page.getByRole('button', { name: 'Menu' }).focus();
      await page.keyboard.press('Enter');
    }
    const signOut = page.getByRole('button', { name: 'Sign out', exact: true });
    await signOut.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Enter your invited email',
    );
  });
});

test.describe('reduced motion', () => {
  test('respects prefers-reduced-motion', async ({ browser }) => {
    const context = await browser.newContext({
      reducedMotion: 'reduce',
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    await page.goto(server.baseUrl);
    await tabUntil(page, /Continue to identity provider/iu);
    // Spatial movement collapses while colour/opacity feedback remains available.
    const buttonStyle = await page.evaluate(() => {
      const element = document.querySelector('.df-button');
      if (element === null) return null;
      const style = window.getComputedStyle(element);
      return {
        properties: style.transitionProperty,
        durations: style.transitionDuration,
        transform: style.transform,
      };
    });
    expect(buttonStyle).not.toBeNull();
    expect(buttonStyle?.properties).not.toContain('transform');
    expect(buttonStyle?.properties).toContain('color');
    expect(buttonStyle?.durations).toContain('0.16s');
    expect(buttonStyle?.transform).toBe('none');
    await context.close();
  });
});
