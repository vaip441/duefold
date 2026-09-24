/**
 * Access, processing, exports, and branding in a real browser.
 *
 * Every case signs in through a genuinely server-issued session, so each request
 * is authorized by the real authenticator against real rows. A test that stubbed
 * the client's view would prove the markup renders while proving nothing about
 * what a Manager may actually see or do.
 *
 * The properties under test are the ones a Manager's decisions depend on:
 *   - an EXPIRED grant is visible and named as expired, not hidden and not shown
 *     as live access;
 *   - grant impact is the SERVER's, shown before anything is applied, behind the
 *     server's typed phrase;
 *   - a refusal is visible AS a refusal, never as an empty state;
 *   - quarantine, malware, and failure states say what they mean, and retry is
 *     offered exactly once;
 *   - an export says it is one-time BEFORE the control;
 *   - ordering and bulk selection are fully keyboard-operable with no drag.
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
  options: Parameters<TestServer['signInMember']>[0] & { readonly roomTitle: string },
): Promise<void> {
  const seeded = await server.signInMember(options);
  await page.context().addCookies(
    seeded.cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      url: cookie.url,
    })),
  );
  await page.goto(server.baseUrl);
  await page
    .getByRole('button', { name: new RegExp(`Open room ${options.roomTitle}`, 'u') })
    .click();
}

/* Processing is reached as the Review step of the preparation path. */
async function openSection(page: Page, name: string): Promise<void> {
  await page
    .getByRole('button', { name: name === 'Processing' ? 'Review' : name, exact: true })
    .click();
}

/** Branding is organization-wide, so it is an Administration section for an Admin. */
async function openBranding(page: Page): Promise<void> {
  const seeded = await server.signInMember({ globalRole: 'admin' });
  await page.context().addCookies(
    seeded.cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      url: cookie.url,
    })),
  );
  await page.goto(`${server.baseUrl}/administration/branding`);
  await expect(page.getByLabel('Accent colour')).toBeVisible();
}

test.describe('participants and grants', () => {
  test('shows an expired grant AS expired rather than hiding it or calling it active', async ({
    page,
  }) => {
    await openRoom(page, {
      roomTitle: 'Expiry room',
      roomRole: 'manager',
      withParticipant: { email: 'lapsed@example.com', grant: 'expired' },
    });
    await openSection(page, 'Access');
    const row = page.getByRole('row', { name: /lapsed@example\.com/u });
    await expect(row).toBeVisible();
    // The grant is present and named as expired, with guidance to fix it.
    await expect(row).toContainText('Expired');
    await expect(row).toContainText('This grant has ended');
    // It must NOT be presented as live access.
    await expect(row).not.toContainText('No end date');
  });

  test('shows an active grant as active in the same surface', async ({ page }) => {
    // Populated positive arm for the assertion above: same layout, live grant.
    await openRoom(page, {
      roomTitle: 'Active room',
      roomRole: 'manager',
      withParticipant: { email: 'current@example.com', grant: 'active' },
    });
    await openSection(page, 'Access');
    const row = page.getByRole('row', { name: /current@example\.com/u });
    await expect(row).toContainText('Active');
    await expect(row).toContainText('Until');
    await expect(row).not.toContainText('This grant has ended');
  });

  test('states a reader with no grants can open the room but read nothing', async ({
    page,
  }) => {
    await openRoom(page, {
      roomTitle: 'Invited room',
      roomRole: 'manager',
      withParticipant: { email: 'invited@example.com', grant: 'none' },
    });
    await openSection(page, 'Access');
    const row = page.getByRole('row', { name: /invited@example\.com/u });
    await expect(row).toContainText('Nothing yet');
    await expect(row).toContainText('no content access');
  });

  test('shows the SERVER impact and requires its phrase before applying a grant', async ({
    page,
  }) => {
    await openRoom(page, {
      roomTitle: 'Grant room',
      roomRole: 'manager',
      withParticipant: { email: 'grantee@example.com', grant: 'none' },
    });
    await openSection(page, 'Access');
    await page.getByRole('button', { name: /Give access grantee@example\.com/u }).click();

    // Choosing the whole room, then asking the server what that changes.
    await page.getByLabel('What they can read').selectOption('room');
    await page.getByRole('button', { name: 'Review this change' }).click();

    // The impact arrives from the server and is shown BEFORE any confirmation.
    await expect(page.getByText('What this changes')).toBeVisible();
    await expect(page.getByText('Nothing changes until you confirm')).toBeVisible();

    // The confirmation field carries the server's phrase, and a wrong phrase is
    // refused client-side before a request is spent.
    const confirm = page.getByLabel(/^Type .+ to confirm$/u);
    await expect(confirm).toBeVisible();
    await confirm.fill('not the phrase');
    await page.getByRole('button', { name: 'Apply this change' }).click();
    await expect(page.getByText('Type the phrase exactly as shown')).toBeVisible();
  });

  test('refuses an invitation that is not an email address before spending a request', async ({
    page,
  }) => {
    await openRoom(page, { roomTitle: 'Invite room', roomRole: 'manager' });
    await openSection(page, 'Access');
    await page.getByLabel('Email address').fill('not-an-address');
    await page.getByRole('button', { name: 'Send invitation' }).click();
    await expect(page.getByText('Enter an email address')).toBeVisible();
  });

  test('offers a Contributor no Access step, even through a typed address', async ({
    page,
  }) => {
    /*
     * The participants reader is Manager-only. A Contributor used to be handed the
     * section anyway and shown a refusal worded for a viewer; now the step is absent,
     * and a typed /participants address falls back to the collection without asking.
     */
    const refused: string[] = [];
    page.on('response', (response) => {
      if (response.status() === 403) refused.push(response.url());
    });
    await openRoom(page, { roomTitle: 'Contributor room', roomRole: 'contributor' });
    const path = page.getByRole('navigation', { name: 'Room preparation' });
    await expect(path.getByRole('button', { name: 'Review', exact: true })).toBeVisible();
    await expect(path.getByRole('button', { name: 'Access', exact: true })).toHaveCount(0);
    await expect(path.getByRole('button', { name: 'Publish', exact: true })).toHaveCount(0);
    await page.goto(`${page.url()}/participants`);
    await expect(page.getByRole('heading', { name: 'Working structure' })).toBeVisible();
    await expect(
      page.getByText('Nobody outside your organization can read this room yet.'),
    ).toHaveCount(0);
    expect(refused).toEqual([]);
  });
});

test.describe('processing states', () => {
  test('names quarantine as isolation and offers no retry for it', async ({ page }) => {
    await openRoom(page, {
      roomTitle: 'Quarantine room',
      roomRole: 'manager',
      withProcessing: [{ title: 'Scanning document', state: 'quarantine' }],
    });
    await openSection(page, 'Processing');
    const row = page.getByRole('row', { name: /Scanning document/u });
    await expect(row).toContainText('Being checked');
    await expect(row).toContainText('Held apart from the room');
    await expect(row.getByRole('button', { name: /Try conversion again/u })).toHaveCount(0);
  });

  test('states malware plainly and never offers a retry', async ({ page }) => {
    await openRoom(page, {
      roomTitle: 'Malware room',
      roomRole: 'manager',
      withProcessing: [{ title: 'Infected upload', state: 'malware_quarantined' }],
    });
    await openSection(page, 'Processing');
    const row = page.getByRole('row', { name: /Infected upload/u });
    await expect(row).toContainText('Malware found');
    await expect(row).toContainText('cannot be published or downloaded');
    await expect(row.getByRole('button', { name: /Try conversion again/u })).toHaveCount(0);
  });

  test('offers retry once for a failed conversion and withdraws it after the attempt', async ({
    page,
  }) => {
    await openRoom(page, {
      roomTitle: 'Retry room',
      roomRole: 'manager',
      withProcessing: [
        { title: 'Retryable document', state: 'processing_failed' },
        { title: 'Already retried', state: 'processing_failed', manualRetryCount: 1 },
      ],
    });
    await openSection(page, 'Processing');
    // Positive arm: a fresh failure can be retried.
    await expect(
      page.getByRole('row', { name: /Retryable document/u }).getByRole('button', {
        name: /Try conversion again/u,
      }),
    ).toBeVisible();
    // Negative arm, same surface: the spent one says so and offers no control.
    const spent = page.getByRole('row', { name: /Already retried/u });
    await expect(spent).toContainText('already been retried');
    await expect(spent.getByRole('button', { name: /Try conversion again/u })).toHaveCount(0);
  });

  test('requires a typed phrase to delete a failed source and warns first', async ({
    page,
  }) => {
    await openRoom(page, {
      roomTitle: 'Delete room',
      roomRole: 'manager',
      withProcessing: [{ title: 'Rejected upload', state: 'rejected' }],
    });
    await openSection(page, 'Processing');
    const row = page.getByRole('row', { name: /Rejected upload/u });
    await row.getByRole('button', { name: /Delete this file/u }).click();
    // The irreversibility warning precedes the confirm control in the DOM.
    const warning = page.getByText('cannot be undone');
    await expect(warning).toBeVisible();
    const confirmButton = page.getByRole('button', { name: 'Delete permanently' });
    const order = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('p,button')];
      const warn = nodes.findIndex((node) => node.textContent?.includes('cannot be undone'));
      const button = nodes.findIndex((node) => node.textContent === 'Delete permanently');
      return { warn, button };
    });
    expect(order.warn).toBeGreaterThanOrEqual(0);
    expect(order.warn).toBeLessThan(order.button);
    // A wrong phrase does not delete.
    await page.getByLabel(/^Type delete to delete$/u).fill('nope');
    await confirmButton.click();
    await expect(page.getByText('Type the phrase exactly as shown')).toBeVisible();
  });

  test('shows an honest empty state when nothing is processing', async ({ page }) => {
    await openRoom(page, { roomTitle: 'Idle room', roomRole: 'manager' });
    await openSection(page, 'Processing');
    await expect(page.getByText('Nothing is being processed.')).toBeVisible();
    // An empty state must not claim a failure.
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});

test.describe('exports', () => {
  test('states the one-time nature and the hour limit before anything is created', async ({
    page,
  }) => {
    await openRoom(page, { roomTitle: 'Export room', roomRole: 'manager' });
    await openSection(page, 'Exports');
    await expect(page.getByText('expires one hour after it is created')).toBeVisible();
    // The unwatermarked-originals warning is present regardless of the checkbox.
    await expect(page.getByText('Original files are not watermarked')).toBeVisible();
    await expect(page.getByText('No exports yet.')).toBeVisible();
  });

  test('shows the server preflight before generating, and can be cancelled', async ({
    page,
  }) => {
    await openRoom(page, { roomTitle: 'Preflight room', roomRole: 'manager' });
    await openSection(page, 'Exports');
    await page.getByRole('button', { name: 'Review this export' }).click();
    await expect(page.getByText('What this export contains')).toBeVisible();
    // One-time warning appears in the preflight too, before the create control.
    await expect(page.getByText('can be downloaded ONCE')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('What this export contains')).toHaveCount(0);
  });
});

test.describe('branding', () => {
  test('rejects an accent that fails contrast and accepts one that passes both themes', async ({
    page,
  }) => {
    await openBranding(page);
    const accent = page.getByLabel('Accent colour');
    // Negative arm: near-white fails against the light ground.
    await accent.fill('#fefefe');
    await expect(page.getByText('too light or too dark')).toBeVisible();
    // Positive arm: a mid-tone accent clears both grounds and the error clears.
    await accent.fill('#0a7d6d');
    await expect(page.getByText('too light or too dark')).toHaveCount(0);
  });

  test('accepts an email, an https link, or empty as the support contact', async ({ page }) => {
    await openBranding(page);
    const contact = page.getByLabel('Support contact');
    // Negative arm: a hostile scheme is refused at the point of entry.
    await contact.fill('javascript:alert(1)');
    await expect(page.getByText('Enter an email address or an https link')).toBeVisible();
    // Positive arms: both accepted shapes, and empty.
    await contact.fill('help@example.com');
    await expect(page.getByText('Enter an email address or an https link')).toHaveCount(0);
    await contact.fill('https://example.com/help');
    await expect(page.getByText('Enter an email address or an https link')).toHaveCount(0);
    await contact.fill('');
    await expect(page.getByText('Enter an email address or an https link')).toHaveCount(0);
  });

  test('states that custom styles and scripts are not accepted', async ({ page }) => {
    await openBranding(page);
    await expect(
      page.getByText('Custom styles, fonts, and scripts are not accepted'),
    ).toBeVisible();
    await expect(page.getByLabel('Organization logo')).toBeVisible();
    await expect(page.getByLabel('Square mark (favicon)')).toBeVisible();
  });
});

test.describe('structure controls and bulk selection', () => {
  test('offers create-folder, and ordering without any drag dependency', async ({ page }) => {
    await openRoom(page, {
      roomTitle: 'Controls room',
      roomRole: 'manager',
      withProcessing: [{ title: 'First document', state: 'quarantine' }],
    });
    await expect(page.getByRole('button', { name: 'New folder' })).toBeVisible();
    await page.getByRole('button', { name: 'Reorder collection' }).click();
    await expect(page.getByText(/Reorder mode is active/u)).toBeVisible();
    // No draggable element exists on this surface at all.
    expect(await page.locator('[draggable="true"]').count()).toBe(0);
  });

  test('selects rows by keyboard alone and reports the count', async ({ page }) => {
    await openRoom(page, {
      roomTitle: 'Selection room',
      roomRole: 'manager',
      withProcessing: [
        { title: 'Alpha document', state: 'quarantine' },
        { title: 'Beta document', state: 'quarantine' },
      ],
    });
    await expect(page.getByText('Nothing selected.')).toBeVisible();
    // Keyboard: focus a row checkbox and toggle it with Space.
    const checkbox = page.getByRole('checkbox', { name: /Select Alpha document/u });
    await checkbox.focus();
    await page.keyboard.press('Space');
    await expect(checkbox).toBeChecked();
    await expect(page.getByText(/1 of 2 selected/u)).toBeVisible();
    // Select-all and clear are ordinary buttons, reachable the same way.
    await page.getByRole('button', { name: 'Select all' }).click();
    await expect(page.getByText(/2 of 2 selected/u)).toBeVisible();
    await page.getByRole('button', { name: 'Clear selection' }).click();
    await expect(page.getByText('Nothing selected.')).toBeVisible();
  });

  test('offers move and metadata editing for a document', async ({ page }) => {
    await openRoom(page, {
      roomTitle: 'Metadata room',
      roomRole: 'manager',
      withProcessing: [{ title: 'Editable document', state: 'quarantine' }],
    });
    const row = page.getByRole('row', { name: /Editable document/u });
    await row.getByRole('button', { name: /Manage Editable document/u }).click();
    await row.getByRole('button', { name: /Edit title and description/u }).click();
    await expect(page.getByLabel('Title of this document')).toHaveValue('Editable document');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await row.getByRole('button', { name: /^Move$/u }).click();
    await expect(page.getByLabel('Destination folder')).toBeVisible();
    await expect(page.getByLabel('Position among siblings')).toBeVisible();
  });

  test('keeps folders as non-interactive context in the collection rail', async ({ page }) => {
    await openRoom(page, {
      roomTitle: 'Rail navigation room',
      roomRole: 'manager',
      withProcessing: [{ title: 'First document', state: 'quarantine' }],
    });
    await page.getByRole('button', { name: 'New folder' }).click();
    // Opening the form puts the caret in the name, and Enter creates the folder.
    await expect(page.getByLabel('Folder name')).toBeFocused();
    await page.keyboard.type('Financials');
    await page.keyboard.press('Enter');
    // Creation is a round trip followed by a workspace reload, which a loaded CI
    // runner does not always finish inside the default expect timeout.
    await expect(page.getByRole('row', { name: /Financials/ })).toBeVisible({
      timeout: 15_000,
    });

    // Click on another section (Access) to leave structure
    await page.getByRole('button', { name: 'Access', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Access' })).toBeVisible();

    // Folders are context in the finding aid, not inert buttons.
    const rail = page.getByRole('navigation', { name: 'Collection' });
    await expect(rail.getByText('Financials', { exact: true })).toBeVisible();
    await expect(rail.getByRole('button', { name: 'Financials' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Access' })).toBeVisible();
  });
});

test.describe('accessibility and responsive behaviour', () => {
  test('reports zero axe violations on Branding', async ({ page }) => {
    await openBranding(page);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });

  for (const section of ['Access', 'Processing', 'Exports'] as const) {
    test(`reports zero axe violations on ${section}`, async ({ page }) => {
      await openRoom(page, {
        roomTitle: `Axe ${section} room`,
        roomRole: 'manager',
        withParticipant: {
          email: `axe-${section.toLowerCase()}@example.com`,
          grant: 'expired',
        },
        withProcessing: [{ title: 'Axe document', state: 'processing_failed' }],
      });
      await openSection(page, section);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(
        results.violations.map((violation) => ({
          id: violation.id,
          nodes: violation.nodes.length,
        })),
      ).toEqual([]);
    });
  }

  test('reports zero axe violations on the populated sections in dark theme', async ({
    page,
  }) => {
    await settleTheme(page, 'dark');
    await openRoom(page, {
      roomTitle: 'Dark room',
      roomRole: 'manager',
      withParticipant: { email: 'dark@example.com', grant: 'expired' },
      withProcessing: [{ title: 'Dark document', state: 'malware_quarantined' }],
    });
    await openSection(page, 'Access');
    const access = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(access.violations.map((violation) => violation.id)).toEqual([]);
    await openSection(page, 'Processing');
    const processing = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(processing.violations.map((violation) => violation.id)).toEqual([]);
  });

  test('fits 320px on every section without horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await openRoom(page, {
      roomTitle: 'Narrow sections',
      roomRole: 'manager',
      withParticipant: { email: 'narrow@example.com', grant: 'expired' },
      withProcessing: [{ title: 'Narrow document', state: 'processing_failed' }],
    });
    for (const section of ['Access', 'Processing', 'Exports'] as const) {
      await openSection(page, section);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, section).toBeLessThanOrEqual(0);
    }
  });

  test('reaches every section by keyboard and announces the current one', async ({ page }) => {
    await openRoom(page, { roomTitle: 'Keyboard sections', roomRole: 'manager' });
    const access = page.getByRole('button', { name: 'Access', exact: true });
    await access.focus();
    await page.keyboard.press('Enter');
    await expect(access).toHaveAttribute('aria-current', 'step');
    const exports = page.getByRole('button', { name: 'Exports', exact: true });
    await exports.focus();
    await page.keyboard.press('Enter');
    await expect(exports).toHaveAttribute('aria-current', 'true');
    // Exactly one place in the path and the supporting strip is current at a time.
    expect(
      await page
        .locator('.df-sections__entry[aria-current], .df-preparation__step[aria-current]')
        .count(),
    ).toBe(1);
  });
});

test.describe('disclosure limits', () => {
  test('exposes no object key, digest, filename, or correlation id in any section', async ({
    page,
  }) => {
    await openRoom(page, {
      roomTitle: 'Leak sections',
      roomRole: 'manager',
      withParticipant: { email: 'leak@example.com', grant: 'expired' },
      withProcessing: [
        { title: 'Leak document', state: 'malware_quarantined' },
        { title: 'Other document', state: 'processing_failed' },
      ],
    });
    for (const section of ['Access', 'Processing', 'Exports'] as const) {
      await openSection(page, section);
      const html = await page.content();
      for (const forbidden of [
        'quarantine/',
        'private-source.pdf',
        'objectKey',
        'object_key',
        'orderKey',
        'order_key',
        'corr_',
        'b'.repeat(64),
      ])
        expect(html, `${section}: ${forbidden}`).not.toContain(forbidden);
    }
  });
});
