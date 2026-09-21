/**
 * Installation status and the installation download default, as the Owner and an Admin who
 * may use them and the members who may not, in both themes, by keyboard and at 320 CSS pixels.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { applicationVersion } from '../../modules/core-security/src/release.ts';
import { startTestServer, type TestServer } from '../support/browser-server.ts';
import { makeSessionStale } from '../support/room-seeding.ts';
import { seedStatusObservation } from '../support/status-seeding.ts';
import { settleTheme } from './theme.ts';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  await server.close();
});

async function signIn(
  page: Page,
  options: Parameters<TestServer['signInMember']>[0],
): Promise<Awaited<ReturnType<TestServer['signInMember']>>> {
  const seeded = await server.signInMember(options);
  await page
    .context()
    .addCookies(seeded.cookies.map(({ name, value, url }) => ({ name, value, url })));
  await page.goto(server.baseUrl);
  return seeded;
}

const sections = (page: Page) =>
  page.getByRole('navigation', { name: 'Administration sections' });

async function openAdministration(
  page: Page,
  section: 'Status' | 'Installation',
): Promise<void> {
  await page.getByRole('button', { name: 'Administration', exact: true }).click();
  await sections(page).getByRole('button', { name: section, exact: true }).click();
}

async function seedStandardObservations(): Promise<void> {
  await seedStatusObservation(server.migrationPool, {
    check: 'storage-privacy',
    result: 'pass',
    code: 'ANONYMOUS_ACCESS_REFUSED',
  });
  await seedStatusObservation(server.migrationPool, {
    check: 'storage-versioning',
    result: 'attention',
    code: 'VERSIONING_NOT_DETECTABLE',
  });
  await seedStatusObservation(server.migrationPool, {
    check: 'scanner',
    result: 'fail',
    code: 'SIGNATURES_STALE',
    evidenceAt: new Date(Date.now() - 3 * 86_400_000),
  });
  await server.migrationPool.query(
    "DELETE FROM deployment_status_observation WHERE check_name = 'updates'",
  );
}

async function assertAllStatusFacts(page: Page): Promise<void> {
  await expect(
    page.getByRole('heading', { level: 2, name: 'Security and deployment status' }),
  ).toBeVisible();
  const table = page.getByRole('table');
  await expect(table).toBeVisible();

  const appRow = page.getByRole('row', { name: /^Application/u });
  await expect(appRow).toContainText('Passing');
  await expect(appRow).toContainText('Now');

  const migRow = page.getByRole('row', { name: /^Database migrations/u });
  await expect(migRow).toContainText('Passing');
  await expect(migRow).toContainText('Now');

  const privRow = page.getByRole('row', { name: /^Storage privacy/u });
  await expect(privRow).toContainText('Passing');
  await expect(privRow.locator('time')).toBeVisible();

  const verRow = page.getByRole('row', { name: /^Storage versioning/u });
  await expect(verRow).toContainText('Needs attention');
  await expect(verRow.locator('time')).toBeVisible();

  const scanRow = page.getByRole('row', { name: /^Malware signatures/u });
  await expect(scanRow).toContainText('Failing');
  await expect(scanRow.locator('time')).toBeVisible();

  const queueRow = page.getByRole('row', { name: /^Worker queue/u });
  await expect(queueRow).toContainText('Passing');
  await expect(queueRow).toContainText('Now');

  const procRow = page.getByRole('row', { name: /^Document processing/u });
  await expect(procRow).toContainText('Passing');
  await expect(procRow).toContainText('Now');

  const oidcRow = page.getByRole('row', { name: /^Member sign-in \(OIDC\)/u });
  await expect(oidcRow).toContainText('Passing');
  await expect(oidcRow.locator('time')).toBeVisible();

  /*
   * These three read off seeded facts, so each has one right answer: no required mail has
   * been delivered, the operator has not acknowledged a backup, and no restore drill has
   * been recorded. Accepting either state would pass whatever the surface decided.
   */
  const mailRow = page.getByRole('row', { name: /^Required mail/u });
  await expect(mailRow).toContainText('Not yet checked');
  await expect(mailRow).not.toContainText('Passing');

  const backupRow = page.getByRole('row', { name: /^Backups/u });
  await expect(backupRow).toContainText('Needs attention');
  await expect(backupRow).not.toContainText('Passing');

  const restoreRow = page.getByRole('row', { name: /^Restore drill/u });
  await expect(restoreRow).toContainText('Needs attention');
  await expect(restoreRow).not.toContainText('Passing');

  const updatesRow = page.getByRole('row', { name: /^Updates and advisories/u });
  await expect(updatesRow).toContainText('Not yet checked');
  await expect(updatesRow).toContainText('Never recorded');
  await expect(updatesRow).not.toContainText('Passing');

  await expect(page.getByRole('alert')).toContainText('Checks failing: 1.');
}

test.describe('the status section', () => {
  /*
   * The Owner must see every §20.2 fact in words with its timestamp, distinguishing passing,
   * attention, failing and unperformed checks without relying on colour alone.
   */
  test('the Owner reads every §20.2 fact in words with its time', async ({ page }) => {
    await seedStandardObservations();
    await signIn(page, { globalRole: 'owner' });
    await openAdministration(page, 'Status');
    await assertAllStatusFacts(page);
  });

  /*
   * Administration authority is shared between Owner and Admin; the Admin reads the identical
   * deployment status facts, worded states, and failure notice.
   */
  test('an Admin reads every §20.2 fact in words with its time', async ({ page }) => {
    await seedStandardObservations();
    await signIn(page, { globalRole: 'admin' });
    await openAdministration(page, 'Status');
    await assertAllStatusFacts(page);
  });

  /*
   * When an update check previously observed an available release that matches what is now
   * running, presentation must treat it as current rather than persisting an obsolete upgrade alert.
   */
  test('an update offer that is now installed reads as current', async ({ page }) => {
    await seedStatusObservation(server.migrationPool, {
      check: 'updates',
      result: 'attention',
      code: 'UPDATE_AVAILABLE',
      evidenceVersion: applicationVersion(),
    });
    await signIn(page, { globalRole: 'owner' });
    await openAdministration(page, 'Status');
    const updateRow = page.getByRole('row', { name: /^Updates and advisories/u });
    await expect(updateRow).toContainText('Passing');
    await expect(updateRow).toContainText('No newer release is known.');
    await expect(updateRow).not.toContainText('Offered release');
  });

  /*
   * The status surface communicates operational health without disclosing provider endpoints,
   * connection strings, encryption secrets, or member email addresses.
   */
  test('no status response contains a configured value or email address', async ({ page }) => {
    await signIn(page, { globalRole: 'owner' });
    const statusRes = await page.request.get(`${server.baseUrl}/api/status`);
    expect(statusRes.status()).toBe(200);
    const statusText = await statusRes.text();

    const contentRes = await page.request.get(`${server.baseUrl}/api/status/content`);
    expect(contentRes.status()).toBe(200);
    const contentText = await contentRes.text();

    for (const text of [statusText, contentText]) {
      for (const envVar of [
        'DUEFOLD_TEST_DATABASE_URL',
        'DUEFOLD_TEST_MIGRATION_DATABASE_URL',
        'DUEFOLD_DATABASE_URL',
      ]) {
        const val = process.env[envVar];
        if (val) expect(text).not.toContain(val);
      }
      expect(text).not.toContain('@');
    }
  });

  /*
   * Organization administration is reserved for Owner and Admin; neither plain Members
   * nor Room Managers may reach the surface or execute any status or installation route.
   */
  test('a plain Member and a Room Manager are offered no Administration view and are refused 403 by all status and installation routes', async ({
    page,
  }) => {
    for (const roleConfig of [
      { label: 'plain Member', options: { globalRole: 'member' as const } },
      {
        label: 'Room Manager',
        options: {
          globalRole: 'member' as const,
          roomTitle: 'Managed room',
          roomRole: 'manager' as const,
        },
      },
    ]) {
      const seeded = await signIn(page, roleConfig.options);
      await expect(
        page.getByRole('button', { name: 'Administration', exact: true }),
      ).toHaveCount(0);

      const statusRes = await page.request.get(`${server.baseUrl}/api/status`);
      expect(statusRes.status(), `${roleConfig.label} GET /api/status`).toBe(403);

      const contentRes = await page.request.get(`${server.baseUrl}/api/status/content`);
      expect(contentRes.status(), `${roleConfig.label} GET /api/status/content`).toBe(403);

      const installRes = await page.request.get(`${server.baseUrl}/api/installation`);
      expect(installRes.status(), `${roleConfig.label} GET /api/installation`).toBe(403);

      const csrf = seeded.cookies.find((cookie) => cookie.name.includes('csrf'))?.value;
      const postRes = await page.request.post(
        `${server.baseUrl}/api/installation/download-policy`,
        {
          data: { action: 'dry-run', policy: 'allow' },
          headers: { 'x-duefold-csrf': csrf ?? '' },
        },
      );
      expect(
        postRes.status(),
        `${roleConfig.label} POST /api/installation/download-policy`,
      ).toBe(403);
    }
  });
});

test.describe('the installation download default', () => {
  /*
   * Changing the installation download default to allow is an expansive change requiring
   * consequence review, an exact confirmation phrase, and a fresh sign-in. Returning the
   * default to denied is an immediate restriction requiring no phrase.
   */
  test('an Admin allows original downloads after review, phrase and a fresh sign-in, then denies them in one press', async ({
    page,
  }) => {
    await signIn(page, { globalRole: 'admin', roomTitle: 'Inheriting room' });
    await openAdministration(page, 'Installation');
    await expect(page.getByText('Denied by default', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Allow original downloads' }).click();
    const allow = page.getByRole('dialog', {
      name: 'Allow original downloads installation-wide',
    });
    await expect(allow).toContainText('rooms that inherit this default');
    await expect(allow).toContainText('ALLOW ORIGINAL DOWNLOADS');

    const submitAllow = allow.getByRole('button', { name: 'Allow original downloads' });
    await expect(submitAllow).toBeDisabled();
    await allow.getByRole('textbox').fill('WRONG PHRASE');
    await expect(submitAllow).toBeDisabled();

    await allow.getByRole('textbox').fill('ALLOW ORIGINAL DOWNLOADS');
    await expect(submitAllow).toBeEnabled();
    await submitAllow.click();

    await expect(allow).toBeHidden();
    await expect(page.getByText('Allowed by default', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Deny original downloads' }).click();
    const deny = page.getByRole('dialog', {
      name: 'Deny original downloads installation-wide',
    });
    await expect(deny).toContainText('Rooms and documents with their own policy keep it');
    await expect(deny.getByRole('textbox')).toHaveCount(0);
    await deny.getByRole('button', { name: 'Deny original downloads' }).click();
    await expect(deny).toBeHidden();
    await expect(page.getByText('Denied by default', { exact: true })).toBeVisible();
  });

  /*
   * Security mutations that broaden access require authentication within the 15-minute window;
   * a stale session cannot apply the allowance and prompts for re-authentication.
   */
  test('a stale sign-in is sent to sign in again before allowing, and nothing changes', async ({
    page,
  }) => {
    const seeded = await signIn(page, { globalRole: 'owner' });
    await makeSessionStale(server.migrationPool, seeded.memberId);
    await openAdministration(page, 'Installation');
    await page.getByRole('button', { name: 'Allow original downloads' }).click();
    const allow = page.getByRole('dialog', {
      name: 'Allow original downloads installation-wide',
    });
    await allow.getByRole('textbox').fill('ALLOW ORIGINAL DOWNLOADS');
    await allow.getByRole('button', { name: 'Allow original downloads' }).click();
    await expect(allow.getByRole('link', { name: 'Sign in again' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByText('Denied by default', { exact: true })).toBeVisible();
  });
});

test.describe('accessibility', () => {
  for (const colorScheme of ['light', 'dark'] as const) {
    /* Contrast tokens and surface styling differ between themes and must be checked independently. */
    test(`Status and the Installation review have no violations (${colorScheme})`, async ({
      page,
    }) => {
      await signIn(page, { globalRole: 'owner' });
      await settleTheme(page, colorScheme);
      await openAdministration(page, 'Status');
      await expect(page.getByRole('table')).toBeVisible();
      expect((await new AxeBuilder({ page }).withTags(WCAG).analyze()).violations).toEqual([]);

      await sections(page).getByRole('button', { name: 'Installation', exact: true }).click();
      await page.getByRole('button', { name: 'Allow original downloads' }).click();
      const allowDialog = page.getByRole('dialog', {
        name: 'Allow original downloads installation-wide',
      });
      await expect(allowDialog).toContainText('ALLOW ORIGINAL DOWNLOADS');
      await expect(allowDialog).toHaveCSS('opacity', '1');
      expect((await new AxeBuilder({ page }).withTags(WCAG).analyze()).violations).toEqual([]);
    });
  }

  /* Keyboard operation verifies focus management, modal trapping, and escape dismissal. */
  test('the review is reached, read and dismissed with the keyboard alone', async ({
    page,
  }) => {
    await signIn(page, { globalRole: 'admin' });
    await page.getByRole('button', { name: 'Administration', exact: true }).focus();
    await page.keyboard.press('Enter');
    await sections(page).getByRole('button', { name: 'Installation', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Allow original downloads' }).focus();
    await page.keyboard.press('Enter');
    const review = page.getByRole('dialog', {
      name: 'Allow original downloads installation-wide',
    });
    await expect(review.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await expect(review).toContainText('ALLOW ORIGINAL DOWNLOADS');
    await page.keyboard.press('Escape');
    await expect(review).toBeHidden();
    await expect(page.getByRole('button', { name: 'Allow original downloads' })).toBeFocused();
  });

  /* Responsive layout at 320 CSS pixels verifies tabular presentation without horizontal body overflow. */
  test('Status does not overflow at 320 CSS pixels', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await signIn(page, { globalRole: 'owner' });
    await openAdministration(page, 'Status');
    await expect(page.getByRole('table')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
