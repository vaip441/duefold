/**
 * Viewer reading room behaviour in a real browser.
 *
 * Every case signs in through a genuinely server-issued viewer session against a
 * real grant, real publication, and a version with real processing evidence, so
 * each request the surface makes is authorized by the real authorizer.
 *
 * The properties under test are the ones a viewer's safety depends on:
 *   - an ungranted viewer reaches nothing, and the surface says so without
 *     disclosing that a room exists;
 *   - the watermark fact and the screenshot-honesty sentence are always present;
 *   - there is no print action, and print styles hide the page;
 *   - selection, copy, and the context menu are NOT disabled;
 *   - find reports its match count in text and announces it;
 *   - a denied download policy offers no download control and says why;
 *   - an allowed policy states that originals are unwatermarked BEFORE the control;
 *   - nothing is persisted to storage, a cache, or a service worker.
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { startTestServer, type TestServer } from '../support/browser-server.ts';
import { settleTheme } from './theme.ts';

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  await server.close();
});

async function signIn(
  page: Page,
  input: Parameters<TestServer['signInViewer']>[0] = {},
): Promise<Awaited<ReturnType<TestServer['signInViewer']>>> {
  const seeded = await server.signInViewer(input);
  await page.context().addCookies(
    seeded.cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      url: cookie.url,
    })),
  );
  await page.goto(server.baseUrl);
  return seeded;
}

/** Opens the seeded document and waits for the reader to settle. */
async function openDocument(page: Page, title = 'Investor model'): Promise<void> {
  await page
    .getByRole('button', { name: /Open room|Series B diligence/u })
    .first()
    .click();
  await expect(
    page.getByRole('navigation', { name: 'Collection' }).getByRole('button', { name: title }),
  ).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Collection' })
    .getByRole('button', { name: title })
    .click();
}

test.describe('viewer reading room', () => {
  test('shows only granted rooms and discloses nothing about others', async ({ page }) => {
    // A viewer with no grant: the room, its title, and its documents all exist in
    // the database, so an empty list here is an authorization result.
    const seeded = await signIn(page, { granted: false, roomTitle: 'Unshared project' });
    const emptyState = page.getByRole('main').getByText('No rooms are shared with you yet.');
    await expect(emptyState).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Collection' })).not.toContainText(
      'No rooms are shared with you yet.',
    );
    const body = (await page.locator('body').textContent()) ?? '';
    expect(body).not.toContain('Unshared project');
    expect(body).not.toContain(seeded.roomId);
    expect(body).not.toContain(seeded.documentId);
  });

  test('lists a granted room and its published documents', async ({ page }) => {
    await signIn(page, { roomTitle: 'Series B diligence', documentTitle: 'Investor model' });
    const open = page.getByRole('main').getByRole('button', { name: /Series B diligence/u });
    await expect(open).toBeVisible();
    await open.click();
    await expect(page.getByText('Materials prepared for your review.')).toBeVisible();
    const collection = page.getByRole('navigation', { name: 'Collection' });
    await expect(collection.getByRole('button', { name: 'Investor model' })).toBeVisible();
    // The folder is disclosed as finding-aid context, with no activation control.
    await expect(collection.getByText('Financials', { exact: true })).toBeVisible();
    await expect(collection.getByRole('button', { name: 'Financials' })).toHaveCount(0);
    await expect(page.getByRole('main').getByRole('table')).toHaveCount(0);
  });

  test('shows an explicit state when the protected room introduction fails to load', async ({
    page,
  }) => {
    await signIn(page);
    await page.route('**/api/viewer/branding/introduction', (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }),
    );
    await page
      .getByRole('main')
      .getByRole('button', { name: /Open room|Series B diligence/u })
      .first()
      .click();
    await expect(page.getByRole('alert')).toContainText(
      'The room introduction could not be loaded.',
    );
  });

  test('states the watermark and screenshot facts, and makes no protection claim', async ({
    page,
  }) => {
    await signIn(page);
    const notes = page.getByRole('complementary');
    await expect(notes).toContainText('marked with your email address');
    await expect(notes).toContainText('outside Duefold');
    const body = (await page.locator('body').textContent()) ?? '';
    expect(body).not.toContain('Counterparties');
    expect(body).not.toContain('No counterparties yet.');
    // No claim that screenshots or workarounds are prevented.
    expect(body).not.toMatch(/cannot be copied|prevent screenshots|drm|copy.protect/iu);
  });

  test('offers no print action and hides protected pages in print styles', async ({ page }) => {
    await signIn(page, { downloadPolicy: 'deny' });
    await openDocument(page);
    // No print control anywhere on the surface.
    await expect(page.getByRole('button', { name: /print/iu })).toHaveCount(0);
    await page.emulateMedia({ media: 'print' });
    const sheet = page.locator('.df-page__sheet');
    await expect(sheet).toHaveCount(1);
    await expect(sheet).toBeHidden();
    await page.emulateMedia({ media: 'screen' });
    await expect(sheet).toBeVisible();
  });

  test('does not disable selection, copy, or the context menu', async ({ page }) => {
    await signIn(page);
    await openDocument(page);
    const run = page.locator('.df-page__run').first();
    await expect(run).toHaveCount(1);
    // 14.2 forbids crippling the page: selection must remain available.
    const userSelect = await run.evaluate((node) => getComputedStyle(node).userSelect);
    expect(userSelect).not.toBe('none');
    const handlers = await page.evaluate(() => ({
      contextMenu: document.oncontextmenu !== null,
      copy: document.oncopy !== null,
      selectStart: document.onselectstart !== null,
    }));
    expect(handlers).toEqual({ contextMenu: false, copy: false, selectStart: false });
  });

  test('keeps the sanitized text layer selectable and reachable', async ({ page }) => {
    await signIn(page);
    await openDocument(page);
    // The extracted text is real text in the DOM, not baked into the image.
    await expect(page.locator('.df-page__text')).toContainText('Revenue grew to 4.2M');
    const image = page.locator('.df-page__image');
    await expect(image).toHaveAttribute('alt', /.+/u);
  });

  test('finds text on the page and reports the count in words', async ({ page }) => {
    await signIn(page);
    await openDocument(page);
    const find = page.getByRole('searchbox', { name: /Find on this page/u });
    await find.fill('revenue');
    await expect(page.getByText(/1 matches on this page/u)).toBeVisible();
    await page.getByRole('button', { name: 'Next match' }).click();
    await expect(page.locator('.df-page__match[data-current="true"]')).toHaveCount(1);
    // A query with no match says so rather than silently showing nothing.
    await find.fill('zzzznotpresent');
    await expect(page.getByText('No matches on this page.')).toBeVisible();
  });

  test('matches accent-insensitively so a plain query finds accented text', async ({
    page,
  }) => {
    await signIn(page);
    await openDocument(page);
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(page.locator('.df-page__text')).toContainText('Appendix');
    await page.getByRole('searchbox', { name: /Find on this page/u }).fill('resume');
    await expect(page.getByText(/1 matches on this page/u)).toBeVisible();
  });

  test('navigates pages by keyboard and announces the new page', async ({ page }) => {
    await signIn(page);
    await openDocument(page);
    await expect(page.locator('.df-page__caption')).toContainText('Page 1 of 2');
    const next = page.getByRole('button', { name: 'Next page' });
    await next.focus();
    await expect(next).toBeFocused();
    await page.keyboard.press('Enter');
    // The shell's own live region, not any role=status (notices share that role).
    await expect(page.getByRole('status', { name: 'Status' })).toContainText('Page 2 of 2');
    // The last page disables forward navigation rather than wrapping silently.
    await expect(next).toBeDisabled();
  });

  test('composes the next page ahead without delivering it, and reuses composed pages', async ({
    page,
  }) => {
    const composed: { readonly page: number; readonly cacheId: string }[] = [];
    let delivered = 0;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/viewer/pages/image') delivered += 1;
    });
    page.on('response', async (response) => {
      if (new URL(response.url()).pathname !== '/api/viewer/pages/cache') return;
      const { pageNumber } = response.request().postDataJSON() as { pageNumber: number };
      const { cacheId } = (await response.json()) as { cacheId: string };
      composed.push({ page: pageNumber, cacheId });
    });
    await signIn(page);
    await openDocument(page);
    await expect(page.locator('.df-page__caption')).toContainText('Page 1 of 2');
    await expect.poll(() => composed.map((entry) => entry.page)).toEqual([1, 2]);
    expect(delivered).toBe(1);

    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(page.locator('.df-page__caption')).toContainText('Page 2 of 2');
    await expect.poll(() => delivered).toBe(2);
    await page.getByRole('button', { name: 'Previous page' }).click();
    await expect(page.locator('.df-page__caption')).toContainText('Page 1 of 2');
    await expect.poll(() => composed.map((entry) => entry.page)).toEqual([1, 2, 2, 1, 2]);
    for (const pageNumber of [1, 2])
      expect(
        new Set(composed.filter((entry) => entry.page === pageNumber).map((e) => e.cacheId))
          .size,
        `page ${String(pageNumber)} composed once`,
      ).toBe(1);
  });

  test('refuses a denied download policy without offering the control', async ({ page }) => {
    await signIn(page, { downloadPolicy: 'deny' });
    await openDocument(page);
    await expect(page.getByText('Downloading is turned off for this document.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download original' })).toHaveCount(0);
  });

  test('warns that originals are unwatermarked before offering the download', async ({
    page,
  }) => {
    await signIn(page, { downloadPolicy: 'allow' });
    await openDocument(page);
    const warning = page.getByText(/originals are not watermarked/iu);
    await expect(warning).toBeVisible();
    const control = page.getByRole('button', { name: 'Download original' });
    await expect(control).toBeVisible();
    // 14.3 requires saying it BEFORE enablement: assert document order, not mere
    // presence, because a warning below the button is a warning after the decision.
    const order = await page.evaluate(() => {
      const notice = [...document.querySelectorAll('*')].find((node) =>
        /originals are not watermarked/iu.test(node.textContent ?? ''),
      );
      const button = [...document.querySelectorAll('button')].find(
        (node) => node.textContent?.trim() === 'Download original',
      );
      if (!notice || !button) return 'missing';
      return notice.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING
        ? 'warning-first'
        : 'button-first';
    });
    expect(order).toBe('warning-first');
  });

  test('persists nothing to storage, caches, or a service worker', async ({ page }) => {
    await signIn(page, { downloadPolicy: 'allow' });
    await openDocument(page);
    const state = await page.evaluate(async () => ({
      local: window.localStorage.length,
      session: window.sessionStorage.length,
      caches: 'caches' in window ? (await caches.keys()).length : 0,
      workers: await navigator.serviceWorker?.getRegistrations().then((list) => list.length),
      databases: (await indexedDB.databases?.())?.length ?? 0,
    }));
    expect(state).toEqual({
      local: 0,
      session: 0,
      caches: 0,
      workers: 0,
      databases: 0,
    });
  });

  test('has no accessibility violations in the populated reader, both themes', async ({
    page,
  }) => {
    await signIn(page, { downloadPolicy: 'allow' });
    await openDocument(page);
    for (const theme of ['light', 'dark'] as const) {
      await settleTheme(page, theme);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations, `${theme}: ${JSON.stringify(results.violations)}`).toEqual([]);
    }
  });

  test('has no accessibility violations with find active, both themes', async ({ page }) => {
    await signIn(page);
    await openDocument(page);
    await page.getByRole('searchbox', { name: /Find on this page/u }).fill('revenue');
    await page.getByRole('button', { name: 'Next match' }).click();
    for (const theme of ['light', 'dark'] as const) {
      await settleTheme(page, theme);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations, `${theme}: ${JSON.stringify(results.violations)}`).toEqual([]);
    }
  });

  test('reads without horizontal overflow at 320px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await signIn(page, { downloadPolicy: 'allow' });
    await page
      .getByRole('button', { name: /Open room|Series B diligence/u })
      .first()
      .click();
    await page.getByRole('button', { name: 'Collection' }).click();
    await page
      .getByRole('navigation', { name: 'Collection' })
      .getByRole('button', { name: 'Investor model' })
      .click();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
