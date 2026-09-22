/**
 * Authentication flows in a real browser against the real Fastify server.
 *
 * These are the tests that prove the client works end to end: the session
 * bootstrap, the OTP request/verify cycle with its rejection, cooldown, and
 * lockout states, sign-out including sign-out-everywhere, and the neutral OIDC
 * failure surface. Each asserts a property that would break if the behaviour
 * regressed, not merely that a page rendered.
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

/** Account actions sit inline on wide layouts and behind the Menu disclosure on
 * phones (the shell's 30rem breakpoint); a wide layout must never show the toggle. */
async function openAccountActions(page: Page): Promise<void> {
  const menu = page.getByRole('button', { name: 'Menu' });
  if ((page.viewportSize()?.width ?? 0) <= 480) await menu.click();
  else await expect(menu).toBeHidden();
}

const INVITED = 'invited-viewer@example.com';
const UNINVITED = 'never-invited@example.com';

test.describe('member sign-in', () => {
  test('presents one action and no email fallback', async ({ page }) => {
    await page.goto(server.baseUrl);
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Continue to identity provider' }),
    ).toBeEnabled();
    // Members have no OTP fallback.
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await expect(page.getByLabel('Email address')).toHaveCount(0);
  });

  test('shows one neutral failure state on the OIDC return path', async ({ page }) => {
    await page.goto(`${server.baseUrl}/sign-in?state=failed`);
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Sign-in did not complete');
    // No internal code, status, or identifier reaches the page.
    const body = await page.locator('body').innerText();
    for (const forbidden of ['OIDC_', 'INTERNAL', 'corr_', '500', 'Error:'])
      expect(body, forbidden).not.toContain(forbidden);
  });

  test('an identity-provider denial lands on the designed surface, not a JSON error', async ({
    page,
  }) => {
    const response = await page.goto(
      `${server.baseUrl}/api/auth/oidc/callback?error=access_denied&error_description=Leaked+text&state=abcdefghijklmnop`,
    );
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('alert')).toContainText('Sign-in did not complete');
    const body = await page.locator('body').innerText();
    expect(body).not.toContain('Leaked');
    expect(body).not.toContain('access_denied');
  });
});

test.describe('viewer OTP', () => {
  test('an invited and an uninvited address reach an identical screen', async ({ page }) => {
    await server.inviteViewer(INVITED);
    const capture = async (email: string): Promise<string> => {
      await page.goto(server.baseUrl);
      await page.getByRole('button', { name: 'I was invited to read documents' }).click();
      await page.getByLabel('Email address').fill(email);
      await page.getByRole('button', { name: 'Send code' }).click();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Check your email');
      return page.locator('main').innerText();
    };
    const invited = await capture(INVITED);
    const uninvited = await capture(UNINVITED);
    // Identical text, so the screen discloses nothing about eligibility.
    expect(invited).toBe(uninvited);
    expect(invited).toContain('If this address has access');
  });

  test('verifies a delivered code and signs the viewer in', async ({ page }) => {
    const email = 'verify-flow@example.com';
    await server.inviteViewer(email);
    await page.goto(`${server.baseUrl}/read`);
    await page.getByLabel('Email address').fill(email);
    await page.getByRole('button', { name: 'Send code' }).click();
    await expect(page.getByLabel('Eight-digit code')).toBeFocused();
    await page.getByLabel('Eight-digit code').fill(await server.deliveredCode(email));
    await page.getByRole('button', { name: 'Verify code' }).click();
    // The signed-in shell replaces the sheet.
    await expect(page.getByRole('navigation', { name: 'Collection' })).toBeVisible();
    await openAccountActions(page);
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  });

  test('rejects a wrong code neutrally and counts the attempt', async ({ page }) => {
    const email = 'reject-flow@example.com';
    await server.inviteViewer(email);
    await page.goto(`${server.baseUrl}/read`);
    await page.getByLabel('Email address').fill(email);
    await page.getByRole('button', { name: 'Send code' }).click();
    await expect(page.getByText('Attempt 1 of 5.')).toBeVisible();
    await page.getByLabel('Eight-digit code').fill('00000000');
    await page.getByRole('button', { name: 'Verify code' }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('That code did not work');
    // Neutral: no statement about the address or the reason.
    await expect(alert).not.toContainText('invited');
    await expect(alert).not.toContainText('expired');
    await expect(page.getByText('Attempt 2 of 5.')).toBeVisible();
    // The field is cleared so the next attempt is deliberate.
    await expect(page.getByLabel('Eight-digit code')).toHaveValue('');
  });

  test('locks the code after five attempts and requires a new one', async ({ page }) => {
    const email = 'lockout-flow@example.com';
    await server.inviteViewer(email);
    await page.goto(`${server.baseUrl}/read`);
    await page.getByLabel('Email address').fill(email);
    await page.getByRole('button', { name: 'Send code' }).click();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await page.getByLabel('Eight-digit code').fill(String(attempt).repeat(8));
      await page.getByRole('button', { name: 'Verify code' }).click();
      if (attempt < 5) await expect(page.getByRole('alert')).toContainText('did not work');
    }
    await expect(page.getByText('Too many attempts for this code')).toBeVisible();
    // Submission is closed off; the only way forward is a new code.
    await expect(page.getByLabel('Eight-digit code')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Verify code' })).toBeDisabled();
  });

  test('holds the resend for 60 seconds and counts down', async ({ page }) => {
    const email = 'cooldown-flow@example.com';
    await server.inviteViewer(email);
    await page.goto(`${server.baseUrl}/read`);
    await page.getByLabel('Email address').fill(email);
    await page.getByRole('button', { name: 'Send code' }).click();
    const resend = page.getByRole('button', { name: 'Send a new code' });
    await expect(resend).toBeDisabled();
    const countdown = page.locator('.df-sheet__actions .df-field__help');
    await expect(countdown).toContainText('You can request a new code in');
    // The countdown advances rather than sitting still.
    await expect(countdown).toContainText(/in 5\d seconds/, { timeout: 15_000 });
  });

  test('rejects a malformed address locally without disclosing eligibility', async ({
    page,
  }) => {
    await page.goto(`${server.baseUrl}/read`);
    const field = page.getByLabel('Email address');
    await field.fill('not-an-address');
    // Submit through the form rather than a pointer event. This makes the
    // explicit noValidate handler deterministic in Firefox under full-suite load.
    await field.press('Enter');
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText('Enter an email address')).toBeVisible();
    // Still on the address step: no request was made.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Enter your invited email',
    );
  });
});

test.describe('session and sign-out', () => {
  test('signs out on this device and returns to the sheet', async ({ page }) => {
    const email = 'sign-out-flow@example.com';
    await server.inviteViewer(email);
    await page.goto(`${server.baseUrl}/read`);
    await page.getByLabel('Email address').fill(email);
    await page.getByRole('button', { name: 'Send code' }).click();
    await page.getByLabel('Eight-digit code').fill(await server.deliveredCode(email));
    await page.getByRole('button', { name: 'Verify code' }).click();
    await expect(page.getByRole('navigation', { name: 'Collection' })).toBeVisible();

    await openAccountActions(page);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Enter your invited email',
    );
    // The session is gone server-side, not merely hidden client-side.
    const session = await page.request.get(`${server.baseUrl}/api/auth/session`);
    expect(await session.json()).toEqual({ authenticated: false });
  });

  test('signs out everywhere, revoking the session family', async ({ page }) => {
    const email = 'sign-out-all-flow@example.com';
    await server.inviteViewer(email);
    await page.goto(`${server.baseUrl}/read`);
    await page.getByLabel('Email address').fill(email);
    await page.getByRole('button', { name: 'Send code' }).click();
    await page.getByLabel('Eight-digit code').fill(await server.deliveredCode(email));
    await page.getByRole('button', { name: 'Verify code' }).click();
    await expect(page.getByRole('navigation', { name: 'Collection' })).toBeVisible();

    await openAccountActions(page);
    await page.getByRole('button', { name: 'Sign out everywhere' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Enter your invited email',
    );
    const session = await page.request.get(`${server.baseUrl}/api/auth/session`);
    expect(await session.json()).toEqual({ authenticated: false });
  });

  test('a reload keeps the session and the CSRF token usable', async ({ page }) => {
    // The token lives in a cookie, so it survives a reload without any client
    // storage.
    const email = 'reload-flow@example.com';
    await server.inviteViewer(email);
    await page.goto(`${server.baseUrl}/read`);
    await page.getByLabel('Email address').fill(email);
    await page.getByRole('button', { name: 'Send code' }).click();
    await page.getByLabel('Eight-digit code').fill(await server.deliveredCode(email));
    await page.getByRole('button', { name: 'Verify code' }).click();
    await expect(page.getByRole('navigation', { name: 'Collection' })).toBeVisible();

    await page.reload();
    await expect(page.getByRole('navigation', { name: 'Collection' })).toBeVisible();
    // Sign-out is a CSRF-protected mutation: it proves the token still works.
    await openAccountActions(page);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Enter your invited email',
    );
  });
});

test.describe('client storage discipline', () => {
  test('persists no session or protected data to browser storage', async ({ page }) => {
    const email = 'storage-flow@example.com';
    await server.inviteViewer(email);
    await page.goto(`${server.baseUrl}/read`);
    await page.getByLabel('Appearance').selectOption('dark');
    await page.getByLabel('Email address').fill(email);
    await page.getByRole('button', { name: 'Send code' }).click();
    await page.getByLabel('Eight-digit code').fill(await server.deliveredCode(email));
    await page.getByRole('button', { name: 'Verify code' }).click();
    await expect(page.getByRole('navigation', { name: 'Collection' })).toBeVisible();

    const stored = await page.evaluate(async () => {
      const databases =
        typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
      return {
        localKeys: Object.keys(window.localStorage),
        theme: window.localStorage.getItem('duefold.theme'),
        session: window.sessionStorage.length,
        databases: databases.length,
        workers: (await navigator.serviceWorker?.getRegistrations())?.length ?? 0,
        caches: typeof caches === 'undefined' ? 0 : (await caches.keys()).length,
      };
    });
    expect(stored).toEqual({
      localKeys: ['duefold.theme'],
      theme: 'dark',
      session: 0,
      databases: 0,
      workers: 0,
      caches: 0,
    });
  });

  test('keeps the session cookie unreadable while the CSRF cookie is readable', async ({
    page,
  }) => {
    const email = 'cookie-flow@example.com';
    await server.inviteViewer(email);
    await page.goto(`${server.baseUrl}/read`);
    await page.getByLabel('Email address').fill(email);
    await page.getByRole('button', { name: 'Send code' }).click();
    await page.getByLabel('Eight-digit code').fill(await server.deliveredCode(email));
    await page.getByRole('button', { name: 'Verify code' }).click();
    await expect(page.getByRole('navigation', { name: 'Collection' })).toBeVisible();

    const visible = await page.evaluate(() => document.cookie);
    // The session secret must never be script-readable.
    expect(visible).not.toContain('__Host-duefold_session');
    // The double-submit token must be, or the client cannot echo it.
    expect(visible).toContain('__Host-duefold_csrf');
  });
});
