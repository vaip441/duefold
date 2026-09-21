/**
 * Room administration journeys and accessibility: creation, visibility transitions,
 * whole-room purge, per-document download exceptions, counterparties and grant reach,
 * in both light and dark themes.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { startTestServer, type TestServer } from '../support/browser-server.ts';
import {
  addDocument,
  archiveRoom,
  makeSessionStale,
  markStructurePublished,
} from '../support/room-seeding.ts';
import { settleTheme } from './theme.ts';

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  await server.close();
});

type SignIn = Parameters<TestServer['signInMember']>[0];

async function signIn(
  page: Page,
  options: SignIn,
): Promise<Awaited<ReturnType<TestServer['signInMember']>>> {
  const seeded = await server.signInMember(options);
  await page
    .context()
    .addCookies(seeded.cookies.map(({ name, value, url }) => ({ name, value, url })));
  await page.goto(server.baseUrl);
  return seeded;
}

async function openSettings(page: Page, roomTitle: string): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`Open room ${roomTitle}`, 'u') }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Room settings' })).toBeVisible();
}

test.describe('creating a room', () => {
  /*
   * Creation requires organization administrative authority and places the creator
   * immediately into the draft room.
   */
  test('an Admin creates a room and lands in it as a draft', async ({ page }) => {
    await signIn(page, { globalRole: 'admin' });
    await page.getByRole('button', { name: 'New room' }).click();
    const dialog = page.getByRole('dialog', { name: 'Create a room' });
    await expect(dialog).toContainText('The room starts as a draft');
    await dialog.getByLabel('Room title').fill('Project Atlas');
    await dialog.getByRole('button', { name: 'Create room' }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByText('Draft', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Archive room' })).toBeVisible();
    /* Structure has not yet been published, so publication cannot be offered. */
    await expect(page.getByRole('button', { name: 'Publish room' })).toHaveCount(0);
  });

  /* Plain members hold no organization administration and must see no creation trigger. */
  test('a plain member is not offered New room', async ({ page }) => {
    await signIn(page, { globalRole: 'member' });
    await expect(page.getByRole('button', { name: 'New room' })).toHaveCount(0);
  });
});

test.describe('room visibility', () => {
  /*
   * Publication requires review, confirmation phrase, and a fresh sign-in. Returning to draft
   * is the access kill switch and must succeed in one unphrased step even on a stale sign-in.
   */
  test('a Room Manager publishes after review, then returns the room to draft in one step on a stale sign-in', async ({
    page,
  }) => {
    const seeded = await signIn(page, {
      globalRole: 'member',
      roomTitle: 'Series A',
      roomRole: 'manager',
      withParticipant: { email: 'reader@example.test', grant: 'active' },
    });
    if (seeded.roomId === null) throw new Error('room not seeded');
    await markStructurePublished(server.migrationPool, seeded.roomId);
    await openSettings(page, 'Series A');

    await page.getByRole('button', { name: 'Publish room' }).click();
    const review = page.getByRole('dialog', { name: 'Publish this room' });
    await expect(review).toContainText('Viewers who gain access: 1');
    const confirm = review.getByRole('button', { name: 'Publish room' });
    await expect(confirm).toBeDisabled();
    await review.getByLabel('Type PUBLISH ROOM to confirm').fill('PUBLISH ROOM');
    await confirm.click();
    await expect(review).toBeHidden();
    await expect(page.getByText('Published', { exact: true })).toBeVisible();

    await makeSessionStale(server.migrationPool, seeded.memberId);

    await page.getByRole('button', { name: 'Return to draft' }).click();
    const kill = page.getByRole('dialog', { name: 'Return this room to draft' });
    await expect(kill.getByRole('textbox')).toHaveCount(0);
    await kill.getByRole('button', { name: 'Return to draft' }).click();
    await expect(kill).toBeHidden();
    await expect(page.getByText('Draft', { exact: true })).toBeVisible();
  });

  /* Contributors hold working-structure mutation rights but no room management authority. */
  test('a Contributor is not offered Settings', async ({ page }) => {
    await signIn(page, {
      globalRole: 'member',
      roomTitle: 'Series B',
      roomRole: 'contributor',
    });
    await page.getByRole('button', { name: /Open room Series B/u }).click();
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toHaveCount(0);
  });
});

test.describe('purge', () => {
  /*
   * Purge locks an archived room against return to draft until explicitly cancelled,
   * after which another purge may be scheduled.
   */
  test('the Owner schedules a purge, cannot return the room to draft, cancels it, and schedules another', async ({
    page,
  }) => {
    const seeded = await signIn(page, { globalRole: 'owner', roomTitle: 'Closed deal' });
    if (seeded.roomId === null) throw new Error('room not seeded');
    await archiveRoom(server.migrationPool, seeded.roomId);
    await openSettings(page, 'Closed deal');

    await page.getByRole('button', { name: 'Schedule purge' }).click();
    const schedule = page.getByRole('dialog', { name: 'Schedule a purge of this room' });
    await expect(schedule).toContainText('30-day cancellation period');
    await schedule
      .getByLabel('Type SCHEDULE ROOM PURGE to confirm')
      .fill('SCHEDULE ROOM PURGE');
    await schedule.getByRole('button', { name: 'Schedule purge' }).click();
    await expect(schedule).toBeHidden();
    await expect(
      page.getByText(/Purge scheduled\. Everything in this room will be deleted after/u),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Return to draft' })).toHaveCount(0);
    await expect(
      page.getByText('A purge is scheduled. Cancel it before returning this room to draft.'),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Cancel purge' }).click();
    const cancel = page.getByRole('dialog', { name: 'Cancel the scheduled purge' });
    await cancel.getByLabel('Type CANCEL ROOM PURGE to confirm').fill('CANCEL ROOM PURGE');
    await cancel.getByRole('button', { name: 'Cancel purge' }).click();
    await expect(cancel).toBeHidden();
    await expect(page.getByText('No purge is scheduled.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Return to draft' })).toBeVisible();

    await page.getByRole('button', { name: 'Schedule purge' }).click();
    const scheduleAgain = page.getByRole('dialog', { name: 'Schedule a purge of this room' });
    await scheduleAgain
      .getByLabel('Type SCHEDULE ROOM PURGE to confirm')
      .fill('SCHEDULE ROOM PURGE');
    await scheduleAgain.getByRole('button', { name: 'Schedule purge' }).click();
    await expect(scheduleAgain).toBeHidden();
    await expect(
      page.getByText(/Purge scheduled\. Everything in this room will be deleted after/u),
    ).toBeVisible();
  });
});

test.describe('download exceptions', () => {
  /*
   * Setting a per-document download override advances document.revision rather than
   * structure entry revision; subsequent metadata updates must match that new counter.
   */
  test('a Room Manager allows downloads for one document and subsequent metadata edits succeed', async ({
    page,
  }) => {
    const seeded = await signIn(page, {
      globalRole: 'member',
      roomTitle: 'Series C',
      roomRole: 'manager',
    });
    if (seeded.roomId === null) throw new Error('room not seeded');
    await addDocument(server.migrationPool, seeded.roomId, seeded.memberId, 'Teaser');
    await page.getByRole('button', { name: /Open room Series C/u }).click();
    await page.getByLabel('Downloads for Teaser').selectOption('allow');
    const dialog = page.getByRole('dialog', { name: 'Change downloads for Teaser' });
    await dialog.getByRole('button', { name: 'Change downloads' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('row', { name: /Teaser/u })).toContainText(
      'Downloads allowed here',
    );

    await page.getByRole('button', { name: /Edit title and description Teaser/u }).click();
    await page.getByLabel('Title of this document').fill('Teaser Overview');
    await page.getByRole('button', { name: 'Save details' }).click();
    await expect(page.getByRole('row', { name: /Teaser Overview/u })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});

test.describe('counterparties', () => {
  /*
   * Counterparty creation, placement, removal, and whole-counterparty grant changes
   * update viewer access boundaries across the roster.
   */
  test('a Room Manager creates a counterparty, places a reader, removes them, and grants access', async ({
    page,
  }) => {
    const seeded = await signIn(page, {
      globalRole: 'member',
      roomTitle: 'Series D',
      roomRole: 'manager',
      withParticipant: { email: 'buyer.reader@example.test', grant: 'active' },
    });
    if (seeded.roomId === null) throw new Error('room not seeded');
    await addDocument(server.migrationPool, seeded.roomId, seeded.memberId, 'Due Diligence');
    await page.getByRole('button', { name: /Open room Series D/u }).click();
    await page.getByRole('button', { name: 'Access', exact: true }).click();
    await page.getByLabel('Counterparty name').fill('Buyer A');
    await page.getByRole('button', { name: 'Create counterparty' }).click();
    await expect(page.getByRole('row', { name: /^Buyer A/u })).toContainText('0');

    const placementTable = page.getByRole('table', {
      name: 'Which counterparty each reader belongs to',
    });

    await placementTable.getByRole('button', { name: 'Place' }).click();
    const placeDialog = page.getByRole('dialog', {
      name: 'Place this reader in a counterparty',
    });
    await expect(placeDialog).toContainText('buyer.reader@example.test gains the access');
    await placeDialog.getByRole('button', { name: 'Place' }).click();
    await expect(placeDialog).toBeHidden();
    await expect(
      placementTable.getByRole('row', { name: /buyer\.reader@example\.test/u }),
    ).toContainText('Buyer A');

    await placementTable.getByRole('button', { name: 'Remove from Buyer A' }).click();
    const removeDialog = page.getByRole('dialog', {
      name: 'Remove this reader from their counterparty',
    });
    await expect(removeDialog).toContainText('buyer.reader@example.test loses the access');
    await removeDialog.getByRole('button', { name: 'Remove from Buyer A' }).click();
    await expect(removeDialog).toBeHidden();
    await expect(
      placementTable.getByRole('row', { name: /buyer\.reader@example\.test/u }),
    ).toContainText('None');

    await page.getByRole('button', { name: 'Grant access to Buyer A' }).click();
    await page.getByLabel('What they can read').selectOption('room');
    await page.getByRole('button', { name: 'Review grant' }).click();
    const grantDialog = page.getByRole('dialog', { name: 'Grant access to Buyer A' });
    await expect(grantDialog).toBeVisible();
    const label = await grantDialog.locator('label').textContent();
    const match = label?.match(/Type (.*?) to confirm/u);
    const phrase = match?.[1];
    if (phrase === undefined)
      throw new Error(`Could not find confirmation phrase in label: ${label}`);
    await grantDialog.getByRole('textbox').fill(phrase);
    await grantDialog.getByRole('button', { name: 'Grant access' }).click();
    await expect(grantDialog).toBeHidden();
  });
});

test.describe('accessibility', () => {
  for (const colorScheme of ['light', 'dark'] as const) {
    /* Contrast tokens and surface styling differ between themes and must be checked independently. */
    test(`Settings with a review open has no violations (${colorScheme})`, async ({ page }) => {
      const seeded = await signIn(page, {
        globalRole: 'owner',
        roomTitle: `Axe Settings ${colorScheme}`,
      });
      await settleTheme(page, colorScheme);
      if (seeded.roomId === null) throw new Error('room not seeded');
      await markStructurePublished(server.migrationPool, seeded.roomId);
      await openSettings(page, `Axe Settings ${colorScheme}`);
      const settingsResults = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(settingsResults.violations).toEqual([]);

      await page.getByRole('button', { name: 'Publish room' }).click();
      const reviewDialog = page.getByRole('dialog', { name: 'Publish this room' });
      await expect(reviewDialog).toContainText('PUBLISH ROOM');
      const dialogResults = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(dialogResults.violations).toEqual([]);
    });

    test(`Access with counterparties has no violations (${colorScheme})`, async ({ page }) => {
      await signIn(page, {
        globalRole: 'member',
        roomTitle: `Axe Access ${colorScheme}`,
        roomRole: 'manager',
        withParticipant: { email: `axe.${colorScheme}@example.test`, grant: 'active' },
      });
      await settleTheme(page, colorScheme);
      await page
        .getByRole('button', { name: new RegExp(`Open room Axe Access ${colorScheme}`, 'u') })
        .click();
      await page.getByRole('button', { name: 'Access', exact: true }).click();
      await page.getByLabel('Counterparty name').fill('Buyer A');
      await page.getByRole('button', { name: 'Create counterparty' }).click();
      await expect(page.getByRole('row', { name: /^Buyer A/u })).toBeVisible();
      const accessResults = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(accessResults.violations).toEqual([]);
    });
  }

  /* Keyboard operation verifies focus management, modal trapping, and escape dismissal. */
  test('a room is created and reviewed for publication with the keyboard alone', async ({
    page,
  }) => {
    const seeded = await signIn(page, { globalRole: 'admin', roomTitle: 'Keyboard review' });
    if (seeded.roomId === null) throw new Error('room not seeded');
    await markStructurePublished(server.migrationPool, seeded.roomId);

    await page.getByRole('button', { name: 'New room' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Room title')).toBeFocused();
    await page.keyboard.type('Keyboard room');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Create a room' })).toBeHidden();

    await page.getByRole('button', { name: 'Rooms', exact: true }).first().focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: /Open room Keyboard review/u }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Settings', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Publish room' }).focus();
    await page.keyboard.press('Enter');
    const review = page.getByRole('dialog', { name: 'Publish this room' });
    await expect(review.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(review).toBeHidden();
    await expect(page.getByRole('button', { name: 'Publish room' })).toBeFocused();
  });

  /* Responsive styling must avoid horizontal overflow at 320 CSS pixels (WCAG 1.4.10). */
  test('Settings does not overflow at 320 CSS pixels', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await signIn(page, { globalRole: 'owner', roomTitle: 'Narrow' });
    await openSettings(page, 'Narrow');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
