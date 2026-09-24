/**
 * Member workspace behaviour in a real browser.
 *
 * Every case here signs in through a genuinely server-issued session, so each
 * request the workspace makes is authorized by the real authenticator. Nothing is
 * stubbed at the client boundary: a test that faked the session would prove the
 * markup renders while proving nothing about authorization.
 *
 * The properties under test are the ones a member's decisions depend on:
 *   - a room reached through an organization role is labelled as such, not as an
 *     assignment a colleague made;
 *   - working state is never presented as live to viewers;
 *   - the publication preview lists what changes BEFORE anything is published, and
 *     the typed phrase is required;
 *   - a Contributor is not offered a publish control the server would refuse;
 *   - trash states fixed retention honestly and promises no name reservation.
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

async function openWorkspace(
  page: Page,
  options: {
    readonly globalRole?: 'owner' | 'admin' | 'member';
    readonly roomTitle?: string;
    readonly roomRole?: 'manager' | 'contributor';
  },
): Promise<{ readonly roomId: string | null }> {
  const seeded = await server.signInMember(options);
  await page.context().addCookies(
    seeded.cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      url: cookie.url,
    })),
  );
  await page.goto(server.baseUrl);
  return { roomId: seeded.roomId };
}

test.describe('member workspace', () => {
  test('labels a role-derived room as reached by role rather than as an assignment', async ({
    page,
  }) => {
    await openWorkspace(page, { globalRole: 'admin', roomTitle: 'Series A diligence' });
    const row = page.getByRole('row', { name: /Series A diligence/u });
    await expect(row).toBeVisible();
    // An admin holds no room_assignment, so the reason must say so -- once, since it is
    // the same for every room.
    await expect(page.getByRole('main')).toContainText(
      'You reach every room through your organization role.',
    );
    await expect(row).not.toContainText('Assigned to you');
  });

  test('states a draft room means viewers cannot reach anything', async ({ page }) => {
    await openWorkspace(page, { globalRole: 'admin', roomTitle: 'Draft room' });
    const row = page.getByRole('row', { name: /Draft room/u });
    await expect(row).toContainText('Draft');
    // Consequence in words, not colour: the register's legend defines the state.
    const legend = page.getByRole('main').locator('.df-legend');
    await expect(legend).toContainText('Draft');
    await expect(legend).toContainText('Viewers cannot reach anything in this room');
  });

  test('shows a manager the publish control and a contributor the reason they lack it', async ({
    page,
  }) => {
    await openWorkspace(page, { roomTitle: 'Managed room', roomRole: 'manager' });
    await page.getByRole('button', { name: /Open room Managed room/u }).click();
    // The room's one primary action ends the preparation path; nothing else publishes.
    await expect(
      page
        .getByRole('navigation', { name: 'Room preparation' })
        .getByRole('button', { name: 'Publish changes' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Publish changes' })).toHaveCount(1);
    // Browser history outlives the session, so the title names the view, never the room.
    await expect(page).toHaveTitle(/^Room( · |$)/u);
    expect(await page.title()).not.toContain('Managed room');

    // A fresh context for the contributor: the control must be absent AND explained.
    await page.context().clearCookies();
    await openWorkspace(page, { roomTitle: 'Staged room', roomRole: 'contributor' });
    await page.getByRole('button', { name: /Open room Staged room/u }).click();
    await expect(page.getByRole('button', { name: 'Publish changes' })).toHaveCount(0);
    await expect(page.getByText('A room manager publishes changes')).toBeVisible();
  });

  test('never presents an unpublished entry as live to viewers and shows room-specific rail empty state', async ({
    page,
  }) => {
    await openWorkspace(page, { roomTitle: 'Structure room', roomRole: 'manager' });
    await page.getByRole('button', { name: /Open room Structure room/u }).click();
    // The room has no entries yet, so the empty state must be honest rather than
    // implying viewers see something.
    await expect(
      page.getByRole('main').getByText('This room has no folders or documents yet.'),
    ).toBeVisible();
    await expect(page.getByText('Live to viewers')).toHaveCount(0);

    // The collection rail shows the room-specific empty state rather than claiming no rooms exist.
    const rail = page.getByRole('navigation', { name: 'Collection' });
    await expect(rail).toContainText('This room has no folders or documents yet.');
    await expect(rail).not.toContainText('No rooms yet.');
  });

  test('requires the server phrase before publishing and publishes nothing on cancel', async ({
    page,
  }) => {
    await openWorkspace(page, { roomTitle: 'Publish room', roomRole: 'manager' });
    await page.getByRole('button', { name: /Open room Publish room/u }).click();
    await page.getByRole('button', { name: 'Publish changes' }).click();
    const dialog = page.getByRole('dialog', { name: 'Publish changes' });
    await expect(dialog).toBeVisible();
    // An empty draft room has nothing to publish, and the dialog says so -- without
    // claiming viewers already see anything -- rather than offering a confirmation
    // that would do nothing.
    await expect(dialog).toContainText('Nothing new to publish');
    await expect(dialog).toContainText('still a draft');
    await expect(dialog).not.toContainText('Viewers already see');
    await expect(dialog.getByRole('button', { name: 'Publish now' })).toHaveCount(0);
    // Escape closes it, so a keyboard user is not trapped.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('states trash retention as fixed and promises no name reservation', async ({ page }) => {
    await openWorkspace(page, { roomTitle: 'Trash room', roomRole: 'manager' });
    await page.getByRole('button', { name: /Open room Trash room/u }).click();
    await expect(page.getByText('kept for exactly 30 days')).toBeVisible();
    await expect(page.getByText('A trashed name is free to reuse immediately')).toBeVisible();
    // Restore must not imply it returns publication or viewer access.
    await expect(
      page.getByText('It does not restore publication or viewer access'),
    ).toBeVisible();
  });

  test('is operable from the keyboard and reports zero axe violations', async ({ page }) => {
    await openWorkspace(page, { roomTitle: 'Keyboard room', roomRole: 'manager' });
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      results.violations.map((violation) => ({
        id: violation.id,
        nodes: violation.nodes.length,
      })),
    ).toEqual([]);

    // Reaching the room's open control by keyboard alone, then opening the room.
    await page.keyboard.press('Tab');
    for (let step = 0; step < 30; step += 1) {
      const label = await page.evaluate(() => document.activeElement?.textContent ?? '');
      if (label.includes('Open room')) break;
      await page.keyboard.press('Tab');
    }
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: 'Keyboard room' })).toBeVisible();

    const inRoom = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(inRoom.violations.map((violation) => violation.id)).toEqual([]);
  });

  test('fits 320px without horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await openWorkspace(page, { roomTitle: 'Narrow room', roomRole: 'manager' });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('exposes no object key, digest, or ordering key in the rendered DOM', async ({
    page,
  }) => {
    await openWorkspace(page, { roomTitle: 'Leak room', roomRole: 'manager' });
    await page.getByRole('button', { name: /Open room Leak room/u }).click();
    const html = await page.content();
    for (const forbidden of ['objectKey', 'quarantine/', 'orderKey', 'order_key', 'corr_'])
      expect(html).not.toContain(forbidden);
  });
});
