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
import { expect, test, type Page, type Request, type Route } from '@playwright/test';
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

/**
 * Opens the seeded document and waits for the reader to settle. A viewer holding one
 * room lands in it directly, so there is no room to choose first.
 */
async function openDocument(page: Page, title = 'Investor model'): Promise<void> {
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

  test('lands a single-room viewer in that room, listing its published documents', async ({
    page,
  }) => {
    await signIn(page, { roomTitle: 'Series B diligence', documentTitle: 'Investor model' });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Series B diligence');
    await expect(page).toHaveURL(/\/read\/rooms\/[A-Za-z0-9_-]+$/u);
    await expect(page.getByText('Materials prepared for your review.')).toBeVisible();
    const collection = page.getByRole('navigation', { name: 'Collection' });
    await expect(collection.getByRole('button', { name: 'Investor model' })).toBeVisible();
    // The folder is disclosed as finding-aid context, with no activation control.
    await expect(collection.getByText('Financials', { exact: true })).toBeVisible();
    await expect(collection.getByRole('button', { name: 'Financials' })).toHaveCount(0);
    // The worktable lists the same contents rather than an instruction to look elsewhere.
    const contents = page.getByRole('navigation', { name: 'Room contents' });
    await expect(contents.getByRole('button', { name: 'Investor model' })).toBeVisible();
    await expect(page.getByRole('main').getByRole('table')).toHaveCount(0);
  });

  test('leaves the arrow keys to scrolling once the page is enlarged', async ({ page }) => {
    // A larger page overflows sideways, and the arrows are how a keyboard user pans it.
    await signIn(page);
    await openDocument(page);
    await page.getByRole('button', { name: 'Larger' }).click();
    await page.getByRole('button', { name: 'Larger' }).click();
    await expect(page.getByRole('group', { name: 'Page size' })).toContainText('200%');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('navigation', { name: 'Document pages' })).toContainText(
      'Page 1 of 2',
    );
    await expect(page).not.toHaveURL(/page=2/u);
  });

  test('keeps the open document and page across a reload and Back', async ({ page }) => {
    await signIn(page);
    await openDocument(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Investor model');
    await page.keyboard.press('ArrowRight');
    await expect(page).toHaveURL(/\/documents\/[A-Za-z0-9_-]+\?page=2$/u);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Investor model');
    await expect(page.getByRole('navigation', { name: 'Document pages' })).toContainText(
      'Page 2 of 2',
    );
    // Page turns replace history, so Back leaves the document for the room.
    await page.goBack();
    await expect(page.getByRole('navigation', { name: 'Room contents' })).toBeVisible();
  });

  test('moves a link from before the /read prefix under it', async ({ page }) => {
    // Only a /read address offers the investor sign-in once the session has ended.
    const { roomId, documentId } = await signIn(page);
    await page.goto(`${server.baseUrl}/rooms/${roomId}/documents/${documentId}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Investor model');
    await expect(page).toHaveURL(
      `${server.baseUrl}/read/rooms/${roomId}/documents/${documentId}`,
    );
  });

  test('shows an explicit state when the protected room introduction fails to load', async ({
    page,
  }) => {
    // Routed before sign-in: the only room opens at once, and with it the introduction.
    await page.route('**/api/viewer/branding/introduction', (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }),
    );
    await signIn(page);
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
    await expect(notes).toContainText('cannot be controlled from here');
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
    await expect(page.getByText(/1 match on this page/u)).toBeVisible();
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
    await expect(page.getByText(/1 match on this page/u)).toBeVisible();
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
    // The collection disclosure starts expanded, so the index is reachable at once.
    await expect(page.getByRole('button', { name: 'Collection' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
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

const LONGER = 'L'.repeat(32);
const LONGER_ACTIVITY = 'A'.repeat(32);
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=',
  'base64',
);

/** Serves a second, five-page document beside the seeded one, so history can move between them. */
async function serveLongerDocument(page: Page): Promise<void> {
  await page.route(`**/api/viewer/document?*documentId=${LONGER}`, (route) =>
    route.fulfill({
      json: {
        document: {
          documentId: LONGER,
          displayTitle: 'Board pack',
          publishedVersionId: 'V'.repeat(32),
          pageCount: 5,
          downloadPolicy: 'allow',
        },
      },
    }),
  );
  for (const path of ['**/api/viewer/previews', '**/api/viewer/pages/cache'])
    await page.route(path, (route) =>
      (route.request().postDataJSON() as { documentId?: string }).documentId === LONGER
        ? route.fulfill({
            json: {
              activityId: LONGER_ACTIVITY,
              correlationId: 'C'.repeat(32),
              cacheId: 'K'.repeat(32),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          })
        : route.fallback(),
    );
  await page.route(`**/api/viewer/pages/text?*documentId=${LONGER}*`, (route) =>
    route.fulfill({ json: { versionId: 'V'.repeat(32), accessibleLabel: 'Page', items: [] } }),
  );
  await page.route(`**/api/viewer/pages/image?cacheId=${'K'.repeat(32)}*`, (route) =>
    route.fulfill({ contentType: 'image/png', body: PIXEL }),
  );
}

/** Moves through history the way Back or Forward does, without a click to reset state. */
async function travelTo(page: Page, path: string): Promise<void> {
  await page.evaluate((target) => {
    window.history.pushState(null, '', target);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

/** Waits until a held request has answered or failed, so a late answer has had its chance. */
async function settled(page: Page, request: Request): Promise<void> {
  await (await request.response())?.finished();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
}

function interstitialTarget(target: string): Record<string, string> {
  return {
    normalizedDomain: `${target}.example`,
    destination: `https://${target}.example/`,
    warning: 'You are about to open an external site.',
    rel: 'noopener noreferrer',
  };
}

test.describe('viewer reading room under late answers', () => {
  test("does not clamp a page with the previous document's page count", async ({ page }) => {
    await serveLongerDocument(page);
    const { roomId } = await signIn(page);
    await openDocument(page);
    const pages = page.getByRole('navigation', { name: 'Document pages' });
    await expect(pages).toContainText('Page 1 of 2');
    await travelTo(page, `/read/rooms/${roomId}/documents/${LONGER}?page=4`);
    await expect(pages).toContainText('Page 4 of 5');
    await expect(page).toHaveURL(new RegExp(`/documents/${LONGER}\\?page=4$`, 'u'));
  });

  test('keeps a cancelled link closed and never shows its destination for a later link', async ({
    page,
  }) => {
    const link = (target: string, y: number): Record<string, unknown> => ({
      text: `Visit ${target}`,
      x: 0.1,
      y,
      width: 0.4,
      height: 0.05,
      link: {
        interstitialPath: `/api/viewer/links/interstitial?target=${target}`,
        normalizedDomain: `${target}.example`,
      },
    });
    await page.route('**/api/viewer/pages/text?*', (route) =>
      route.fulfill({
        json: {
          versionId: 'V'.repeat(32),
          accessibleLabel: 'Page 1',
          items: [link('first', 0.1), link('second', 0.5)],
        },
      }),
    );
    const held: Route[] = [];
    await page.route(
      (url) => url.pathname === '/api/viewer/links/interstitial',
      (route) => {
        const target = new URL(route.request().url()).searchParams.get('target') ?? '';
        if (target === 'first') held.push(route);
        else return route.fulfill({ json: interstitialTarget(target) });
        return undefined;
      },
    );
    const releaseFirst = async (): Promise<void> => {
      const route = held.shift();
      if (route === undefined) throw new Error('LINK_NOT_HELD');
      await route.fulfill({ json: interstitialTarget('first') });
      await settled(page, route.request());
    };
    await signIn(page);
    await openDocument(page);
    const dialog = page.getByRole('dialog', { name: 'You are leaving the document room' });
    const first = page.getByRole('button', { name: /first\.example/u });

    await first.click();
    await expect(dialog).toContainText('Checking this link');
    await dialog.getByRole('button', { name: 'Stay here' }).click();
    await expect(dialog).toBeHidden();
    await releaseFirst();
    await expect(dialog).toBeHidden();

    await first.click();
    await dialog.getByRole('button', { name: 'Stay here' }).click();
    await page.getByRole('button', { name: /second\.example/u }).click();
    await expect(dialog.locator('.df-interstitial__domain')).toHaveText('second.example');
    await releaseFirst();
    await expect(dialog.locator('.df-interstitial__domain')).toHaveText('second.example');
  });

  test('leaves a download behind with the document it was started from', async ({ page }) => {
    await serveLongerDocument(page);
    let heldLease: Route | undefined;
    await page.route('**/api/viewer/downloads', (route) => {
      heldLease = route;
    });
    const saved: string[] = [];
    page.on('download', (download) => {
      saved.push(download.suggestedFilename());
    });
    const { roomId } = await signIn(page, { downloadPolicy: 'allow' });
    await openDocument(page);
    await page.getByRole('button', { name: 'Download original' }).click();
    await expect(page.getByRole('button', { name: 'Cancel download' })).toBeVisible();
    await expect.poll(() => heldLease).toBeDefined();

    await travelTo(page, `/read/rooms/${roomId}/documents/${LONGER}`);
    await expect(page.getByRole('navigation', { name: 'Document pages' })).toContainText(
      'Page 1 of 5',
    );
    await heldLease?.continue();
    if (heldLease !== undefined) await settled(page, heldLease.request());

    await expect(page.getByRole('button', { name: 'Download original' })).toBeVisible();
    await expect(page.getByText(/% downloaded/u)).toHaveCount(0);
    expect(saved).toEqual([]);
  });

  test('settles a download cancelled while its lease is still pending', async ({ page }) => {
    let heldLease: Route | undefined;
    await page.route('**/api/viewer/downloads', (route) => {
      heldLease = route;
    });
    await signIn(page, { downloadPolicy: 'allow' });
    await openDocument(page);
    await page.getByRole('button', { name: 'Download original' }).click();
    await expect.poll(() => heldLease).toBeDefined();

    await page.getByRole('button', { name: 'Cancel download' }).click();
    await expect(page.getByRole('region', { name: 'Original file' })).toContainText(
      'Download cancelled. Nothing was saved.',
    );
    await expect(page.getByText(/% downloaded/u)).toHaveCount(0);
  });

  test('keeps the next document open when the refused one is re-read late', async ({
    page,
  }) => {
    await serveLongerDocument(page);
    const { roomId, documentId } = await signIn(page);
    await openDocument(page);
    await expect(page.locator('.df-page__caption')).toContainText('Page 1 of 2');
    await page.route('**/api/viewer/previews', (route) =>
      (route.request().postDataJSON() as { documentId: string }).documentId === LONGER
        ? route.fallback()
        : route.fulfill({
            status: 404,
            json: {
              error: { code: 'NOT_FOUND', message: 'The requested resource was not found.' },
            },
          }),
    );
    let heldRead: Route | undefined;
    await page.route(`**/api/viewer/document?*documentId=${documentId}`, (route) => {
      heldRead = route;
    });
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect.poll(() => heldRead).toBeDefined();

    await travelTo(page, `/read/rooms/${roomId}/documents/${LONGER}`);
    await expect(page.locator('.df-page__caption')).toContainText('Page 1 of 5');
    // Unpublished meanwhile: the answer belongs to the document the reader left.
    await heldRead?.fulfill({ json: { document: null } });
    if (heldRead !== undefined) await settled(page, heldRead.request());
    await expect(page.locator('.df-page__caption')).toContainText('Page 1 of 5');
    await expect(page.getByText('Your access to this room has changed.')).toHaveCount(0);
  });

  test('stops heartbeats once Back leaves the document', async ({ page }) => {
    await page.clock.install();
    // Counted in the page as fetch is called, so an interval tick is observed synchronously.
    await page.addInitScript(() => {
      const original = window.fetch.bind(window);
      const counted = window as Window & { heartbeats?: number };
      counted.heartbeats = 0;
      window.fetch = (input, init) => {
        if (input === '/api/viewer/previews/heartbeat')
          counted.heartbeats = (counted.heartbeats ?? 0) + 1;
        return original(input, init);
      };
    });
    // Real seconds pass while the page clock jumps minutes, so the server would refuse the beat.
    await page.route('**/api/viewer/previews/heartbeat', (route) =>
      route.fulfill({ json: { accepted: true } }),
    );
    const heartbeats = (): Promise<number | undefined> =>
      page.evaluate(() => (window as Window & { heartbeats?: number }).heartbeats);
    await signIn(page);
    await openDocument(page);
    await expect(page.locator('.df-page__caption')).toContainText('Page 1 of 2');
    await page.clock.runFor(60_000);
    expect(await heartbeats()).toBe(1);

    await page.goBack();
    await expect(page.getByRole('navigation', { name: 'Room contents' })).toBeVisible();
    // Interaction keeps the two-minute inactivity close from standing in for a beat.
    await page.keyboard.press('Shift');
    await page.clock.runFor(60_000);
    expect(await heartbeats()).toBe(1);
  });

  test("keeps reading when the previous document's heartbeat is refused late", async ({
    page,
  }) => {
    await page.clock.install();
    await serveLongerDocument(page);
    const beats: string[] = [];
    let heldBeat: Route | undefined;
    await page.route('**/api/viewer/previews/heartbeat', (route) => {
      const { activityId } = route.request().postDataJSON() as { activityId: string };
      beats.push(activityId);
      if (activityId === LONGER_ACTIVITY) return route.fulfill({ json: { accepted: true } });
      heldBeat = route;
      return undefined;
    });
    const { roomId } = await signIn(page);
    await openDocument(page);
    await expect(page.locator('.df-page__caption')).toContainText('Page 1 of 2');
    await page.clock.runFor(60_000);
    await expect.poll(() => heldBeat).toBeDefined();

    await travelTo(page, `/read/rooms/${roomId}/documents/${LONGER}`);
    await expect(page.locator('.df-page__caption')).toContainText('Page 1 of 5');
    // The first document's activity is closed by now, so its heartbeat is refused.
    await heldBeat?.fulfill({ json: { accepted: false } });
    await (await heldBeat?.request().response())?.finished();

    await page.clock.runFor(60_000);
    await expect.poll(() => beats).toContain(LONGER_ACTIVITY);
    await expect(page.getByText('Your access to this room has changed.')).toHaveCount(0);
  });
});

test.describe('viewer reading room after its preview activity ended', () => {
  const pageImageWidth = (page: Page): Promise<number> =>
    page.locator('.df-page__image').evaluate((image: HTMLImageElement) => image.naturalWidth);

  /** Unpublishes the open document: its activity is refused and its metadata is gone. */
  const withdraw = async (page: Page, documentId: string): Promise<void> => {
    await page.route('**/api/viewer/previews', (route) =>
      (route.request().postDataJSON() as { documentId: string }).documentId === LONGER
        ? route.fallback()
        : route.fulfill({
            status: 404,
            json: {
              error: { code: 'NOT_FOUND', message: 'The requested resource was not found.' },
            },
          }),
    );
    await page.route(`**/api/viewer/document?*documentId=${documentId}`, (route) =>
      route.fulfill({ json: { document: null } }),
    );
  };

  test('loads the next page after another tab or the server ended the activity', async ({
    page,
  }) => {
    const { viewerId } = await signIn(page);
    await openDocument(page);
    await expect(page.locator('.df-page__caption')).toContainText('Page 1 of 2');
    // Tabs of one session share the row, and a paused tab's row is ended by the server.
    await server.migrationPool.query(
      "UPDATE preview_activity SET state='closed',summarized_at=statement_timestamp() WHERE viewer_id=$1",
      [viewerId],
    );
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(page.locator('.df-page__caption')).toContainText('Page 2 of 2');
    await expect.poll(() => pageImageWidth(page)).toBeGreaterThan(0);
    await expect(page.getByText('This page could not be shown.')).toHaveCount(0);
  });

  test('reads on from a version published while open, and returns to the room once it is withdrawn', async ({
    page,
  }) => {
    const { roomId, documentId } = await signIn(page);
    await openDocument(page);
    await expect(page.locator('.df-page__caption')).toContainText('Page 1 of 2');
    const republished = 'W'.repeat(32);
    let disclosed = true;
    await page.route('**/api/viewer/previews', (route) =>
      disclosed &&
      (route.request().postDataJSON() as { versionId: string }).versionId === republished
        ? route.fulfill({
            status: 201,
            json: { activityId: LONGER_ACTIVITY, correlationId: `corr_${'C'.repeat(32)}` },
          })
        : route.fulfill({
            status: 404,
            json: {
              error: { code: 'NOT_FOUND', message: 'The requested resource was not found.' },
            },
          }),
    );
    await page.route('**/api/viewer/document?*', (route) =>
      route.fulfill({
        json: {
          document: disclosed
            ? {
                documentId,
                displayTitle: 'Investor model',
                publishedVersionId: republished,
                pageCount: 3,
                downloadPolicy: 'allow',
              }
            : null,
        },
      }),
    );
    await page.route('**/api/viewer/pages/cache', (route) =>
      route.fulfill({
        status: 201,
        json: {
          cacheId: 'K'.repeat(32),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      }),
    );
    await page.route('**/api/viewer/pages/text?*', (route) =>
      route.fulfill({ json: { versionId: republished, accessibleLabel: 'Page', items: [] } }),
    );
    await page.route(`**/api/viewer/pages/image?cacheId=${'K'.repeat(32)}*`, (route) =>
      route.fulfill({ contentType: 'image/png', body: PIXEL }),
    );

    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(page.locator('.df-page__caption')).toContainText('Page 2 of 3');
    await expect.poll(() => pageImageWidth(page)).toBeGreaterThan(0);
    await expect(page.getByText('Your access to this room has changed.')).toHaveCount(0);

    disclosed = false;
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(
      page.getByRole('main').getByText('This document is not available to read.'),
    ).toBeVisible();
    await expect(page.getByRole('status', { name: 'Status' })).toContainText(
      'This document is not available to read.',
    );
    await expect(page).toHaveURL(`${server.baseUrl}/read/rooms/${roomId}`);
    await expect(page.getByRole('navigation', { name: 'Room contents' })).toBeVisible();
    await expect(page.getByText('Your access to this room has changed.')).toHaveCount(0);
  });

  for (const [outcome, answer] of [
    ['finds nothing left to read', { json: { entries: [] } }],
    [
      'is refused',
      {
        status: 403,
        json: { error: { code: 'FORBIDDEN', message: 'The request is not permitted.' } },
      },
    ],
  ] as const)
    test(`stops the room when its re-read after a withdrawal ${outcome}`, async ({ page }) => {
      const { documentId } = await signIn(page);
      await openDocument(page);
      await expect(page.locator('.df-page__caption')).toContainText('Page 1 of 2');
      await withdraw(page, documentId);
      await page.route('**/api/viewer/structure?*', (route) => route.fulfill(answer));
      await page.getByRole('button', { name: 'Next page' }).click();
      await expect(page.getByText('Your access to this room has changed.')).toBeVisible();
    });

  test('shows the withdrawn document as unavailable while the room cannot be re-read', async ({
    page,
  }) => {
    const { documentId } = await signIn(page);
    await openDocument(page);
    await expect(page.locator('.df-page__caption')).toContainText('Page 1 of 2');
    await withdraw(page, documentId);
    await page.route('**/api/viewer/structure?*', (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }),
    );
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(
      page.getByRole('main').getByText('This document is not available to read.'),
    ).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Document pages' })).toHaveCount(0);
    await expect(page.getByText('Your access to this room has changed.')).toHaveCount(0);
  });

  test('keeps the next document open when the room is re-read late', async ({ page }) => {
    await serveLongerDocument(page);
    const { roomId, documentId } = await signIn(page);
    await openDocument(page);
    await expect(page.locator('.df-page__caption')).toContainText('Page 1 of 2');
    await withdraw(page, documentId);
    let heldStructure: Route | undefined;
    await page.route('**/api/viewer/structure?*', (route) => {
      heldStructure = route;
    });
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect.poll(() => heldStructure).toBeDefined();

    await travelTo(page, `/read/rooms/${roomId}/documents/${LONGER}`);
    await expect(page.locator('.df-page__caption')).toContainText('Page 1 of 5');
    // The real room still discloses documents, so a stale answer would return to the room.
    await heldStructure?.continue();
    if (heldStructure !== undefined) await settled(page, heldStructure.request());
    await expect(page).toHaveURL(new RegExp(`/documents/${LONGER}$`, 'u'));
    await expect(page.locator('.df-page__caption')).toContainText('Page 1 of 5');
  });

  test("keeps the room's re-read when its first read of a directly opened document answers late", async ({
    page,
  }) => {
    const { roomId, documentId } = await signIn(page);
    await expect(page.getByRole('navigation', { name: 'Room contents' })).toBeVisible();
    await withdraw(page, documentId);
    let metadataReads = 0;
    await page.route(`**/api/viewer/document?*documentId=${documentId}`, (route) =>
      (metadataReads += 1) === 1 ? route.continue() : route.fallback(),
    );
    let firstRead: Route | undefined;
    await page.route('**/api/viewer/structure?*', (route) => {
      if (firstRead === undefined) {
        firstRead = route;
        return;
      }
      return route.fulfill({
        json: {
          entries: [
            {
              entryId: 'E'.repeat(32),
              resourceKind: 'document',
              resourceId: LONGER,
              parentFolderId: null,
              displayName: 'Board pack',
              description: '',
              publishedVersionId: 'V'.repeat(32),
              siblingPosition: 0,
            },
          ],
        },
      });
    });
    await page.goto(`${server.baseUrl}/read/rooms/${roomId}/documents/${documentId}`);
    const contents = page.getByRole('navigation', { name: 'Room contents' });
    await expect(contents.getByRole('button', { name: 'Board pack' })).toBeVisible();

    await firstRead?.continue();
    if (firstRead !== undefined) await settled(page, firstRead.request());
    await expect(contents.getByRole('button', { name: 'Board pack' })).toBeVisible();
    await expect(contents.getByRole('button', { name: 'Investor model' })).toHaveCount(0);
  });
});

test.describe('viewer reading room after losing access', () => {
  const refusePages = async (page: Page, status: 401 | 403): Promise<void> => {
    await page.route('**/api/viewer/pages/text?*', (route) =>
      route.fulfill({ status, contentType: 'application/json', body: '{}' }),
    );
  };

  test('returns to a re-read room list when one room refuses, keeping the others', async ({
    page,
  }) => {
    await signIn(page);
    await openDocument(page);
    await expect(page.locator('.df-page__caption')).toContainText('Page 1 of 2');
    let roomReads = 0;
    await page.route('**/api/viewer/rooms', async (route) => {
      roomReads += 1;
      const response = await route.fetch();
      const { rooms } = (await response.json()) as { rooms: unknown[] };
      await route.fulfill({
        response,
        json: {
          rooms: [...rooms, { roomId: 'O'.repeat(32), title: 'Seed round', description: '' }],
        },
      });
    });
    await refusePages(page, 403);
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(page.getByText('Your access to this room has changed.')).toBeVisible();
    await expect(page).toHaveURL(`${server.baseUrl}/read`);
    await expect(
      page.getByRole('main').getByRole('button', { name: 'Seed round' }),
    ).toBeVisible();
    expect(roomReads).toBe(1);
  });

  test('keeps a lost single room on the room list when it refuses before the list first answers', async ({
    page,
  }) => {
    const { roomId, documentId } = await signIn(page);
    await expect(page.getByRole('navigation', { name: 'Room contents' })).toBeVisible();
    let firstRoomsRead = true;
    await page.route('**/api/viewer/rooms', (route) => {
      if (firstRoomsRead) {
        firstRoomsRead = false;
        return;
      }
      return route.continue();
    });
    await refusePages(page, 403);
    await page.goto(`${server.baseUrl}/read/rooms/${roomId}/documents/${documentId}`);
    await expect(
      page.getByRole('main').getByRole('button', { name: 'Series B diligence' }),
    ).toBeVisible();
    // The single-room landing would act on this re-read, so give it a frame to do so.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    await expect(page).toHaveURL(`${server.baseUrl}/read`);
    await expect(page.getByText('Your access to this room has changed.')).toBeVisible();
  });

  test('stops every room once the session has ended', async ({ page }) => {
    await signIn(page);
    await openDocument(page);
    await expect(page.locator('.df-page__caption')).toContainText('Page 1 of 2');
    await refusePages(page, 401);
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(
      page
        .getByRole('main')
        .getByText('Your session has ended. Sign in again to keep reading.'),
    ).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Document pages' })).toHaveCount(0);
    await expect(page.getByText('Your access to this room has changed.')).toHaveCount(0);
  });
});
