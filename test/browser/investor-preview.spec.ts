/**
 * A Room Manager checks that published files render before investors arrive.
 *
 * Every case runs on a real server-issued member session against a room holding a
 * processed, published document, so each preview request is authorized by the real
 * database functions.
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

async function openRoom(
  page: Page,
  roomRole: 'manager' | 'contributor',
): Promise<{ readonly roomId: string; readonly documentId: string }> {
  const seeded = await server.signInMember({
    roomTitle: 'Series C diligence',
    roomRole,
    withPublishedDocument: { title: 'Investor model' },
  });
  await page.context().addCookies(
    seeded.cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      url: cookie.url,
    })),
  );
  if (seeded.roomId === null || seeded.publishedDocumentId === null)
    throw new Error('ROOM_FIXTURE_ABSENT');
  await page.goto(`${server.baseUrl}/rooms/${seeded.roomId}`);
  return { roomId: seeded.roomId, documentId: seeded.publishedDocumentId };
}

async function openPreviewDocument(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Room preparation' })
    .getByRole('button', { name: 'Preview as investor' })
    .click();
  await page.getByRole('main').getByRole('button', { name: 'Investor model' }).click();
  await expect(page.locator('.df-page__caption')).toContainText('Page 1 of 2');
}

test.describe('investor preview', () => {
  test('lets a Room Manager page through a published document and exit', async ({ page }) => {
    const requested: string[] = [];
    page.on('request', (request) => {
      requested.push(new URL(request.url()).pathname);
    });
    const { roomId, documentId } = await openRoom(page, 'manager');
    await page.getByRole('button', { name: 'Preview as investor' }).click();
    await expect(page).toHaveURL(new RegExp(`/rooms/${roomId}/preview$`, 'u'));
    await expect(page).toHaveTitle(/^Investor preview( · |$)/u);
    await expect(page.getByRole('main')).toContainText(
      'Pages are shown without the investor watermark. Downloads and links are inactive.',
    );
    await expect(page.getByRole('complementary')).toContainText(
      'recorded in the room audit under your name',
    );

    await page.getByRole('main').getByRole('button', { name: 'Investor model' }).click();
    await expect(page).toHaveURL(
      new RegExp(`/rooms/${roomId}/preview/documents/${documentId}$`, 'u'),
    );
    await expect(page.locator('.df-page__text')).toContainText('Revenue grew to 4.2M');
    await expect(page.locator('.df-page__image')).toHaveAttribute('alt', 'Page 1');
    await expect(
      page.getByText('Investors cannot download the original of this document.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /download/iu })).toHaveCount(0);

    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(page.locator('.df-page__caption')).toContainText('Page 2 of 2');
    await expect(page).toHaveURL(/\?page=2$/u);
    await expect(page.locator('.df-page__text')).toContainText('Appendix');

    // The preview reads member routes only: nothing composes a watermark or opens evidence.
    expect(requested.filter((path) => path.startsWith('/api/viewer/'))).toEqual([]);
    expect(requested).toContain('/api/rooms/preview/page/image');

    await page.getByRole('button', { name: 'Exit preview' }).click();
    await expect(page).toHaveURL(new RegExp(`/rooms/${roomId}$`, 'u'));
    await expect(
      page.getByRole('navigation', { name: 'Room preparation' }).getByRole('button', {
        name: 'Publish changes',
      }),
    ).toBeVisible();
  });

  test('keeps the document and page across a reload, and clamps a stale page', async ({
    page,
  }) => {
    const { roomId, documentId } = await openRoom(page, 'manager');
    await page.goto(`${server.baseUrl}/rooms/${roomId}/preview/documents/${documentId}?page=2`);
    await expect(page.locator('.df-page__caption')).toContainText('Page 2 of 2');
    await page.reload();
    await expect(page.locator('.df-page__caption')).toContainText('Page 2 of 2');
    await page.goto(
      `${server.baseUrl}/rooms/${roomId}/preview/documents/${documentId}?page=999`,
    );
    await expect(page.locator('.df-page__caption')).toContainText('Page 1 of 2');
    await expect(page).toHaveURL(new RegExp(`/preview/documents/${documentId}$`, 'u'));
  });

  test('shows a failed page image as a retryable failure, not a blank sheet', async ({
    page,
  }) => {
    let failImage = true;
    await page.route('**/api/rooms/preview/page/image?*', async (route) => {
      if (failImage) await route.fulfill({ status: 500, body: '' });
      else await route.fallback();
    });
    await openRoom(page, 'manager');
    await page.getByRole('button', { name: 'Preview as investor' }).click();
    await page.getByRole('main').getByRole('button', { name: 'Investor model' }).click();
    await expect(page.getByRole('alert')).toContainText('This page could not be shown.');
    failImage = false;
    await page.getByRole('button', { name: 'Load this page again' }).click();
    await expect(page.locator('.df-page__image')).toHaveAttribute('alt', 'Page 1');
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test("does not clamp a page with the previous document's page count", async ({ page }) => {
    /* A second, longer document is served by the test, so moving through history from a
       two-page document to page 4 of a five-page one exercises the metadata hand-over. */
    const longer = 'L'.repeat(32);
    await page.route(`**/api/rooms/preview/document?*documentId=${longer}`, (route) =>
      route.fulfill({
        json: {
          document: {
            documentId: longer,
            displayTitle: 'Board pack',
            publishedVersionId: 'V'.repeat(32),
            pageCount: 5,
            downloadPolicy: 'allow',
          },
        },
      }),
    );
    await page.route(`**/api/rooms/preview/page/text?*documentId=${longer}*`, (route) =>
      route.fulfill({
        json: { versionId: 'V'.repeat(32), accessibleLabel: 'Page 4', items: [] },
      }),
    );
    await page.route(`**/api/rooms/preview/page/image?*documentId=${longer}*`, (route) =>
      route.fulfill({
        contentType: 'image/png',
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=',
          'base64',
        ),
      }),
    );
    const { roomId, documentId } = await openRoom(page, 'manager');
    await page.goto(`${server.baseUrl}/rooms/${roomId}/preview/documents/${documentId}`);
    await expect(page.locator('.df-page__caption')).toContainText('Page 1 of 2');
    await page.evaluate((path) => {
      window.history.pushState(null, '', path);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, `/rooms/${roomId}/preview/documents/${longer}?page=4`);
    await expect(page.locator('.df-page__caption')).toContainText('Page 4 of 5');
    await expect(page).toHaveURL(new RegExp(`/documents/${longer}\\?page=4$`, 'u'));
    await expect(
      page.getByText('Investors can download the original of this document.'),
    ).toBeVisible();
  });

  test('does not offer a Contributor the preview, and refuses the address', async ({
    page,
  }) => {
    const { roomId } = await openRoom(page, 'contributor');
    await expect(page.getByRole('button', { name: 'Publish changes' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Preview as investor' })).toHaveCount(0);
    // A hidden control is not the boundary: the address itself is refused by the server.
    await page.goto(`${server.baseUrl}/rooms/${roomId}/preview`);
    await expect(page.getByRole('alert')).toContainText('You can no longer preview this room.');
    await expect(
      page.getByRole('main').getByRole('button', { name: 'Investor model' }),
    ).toHaveCount(0);
  });

  test('has no accessibility violations in the open preview, both themes', async ({ page }) => {
    await openRoom(page, 'manager');
    await openPreviewDocument(page);
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
    await openRoom(page, 'manager');
    await openPreviewDocument(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
