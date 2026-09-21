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

async function openMembers(
  page: Page,
  options: Parameters<TestServer['signInMember']>[0] = {},
): Promise<Awaited<ReturnType<TestServer['signInMember']>>> {
  const seeded = await server.signInMember({ globalRole: 'owner', ...options });
  await page.context().addCookies(
    seeded.cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      url: cookie.url,
    })),
  );
  await page.goto(server.baseUrl);
  await page.getByRole('button', { name: 'Administration', exact: true }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Members' })).toBeVisible();
  return seeded;
}

const POPULATED: Parameters<TestServer['signInMember']>[0] = {
  globalRole: 'owner',
  roomTitle: 'Series A',
  withColleagues: {
    members: [{ globalRole: 'member', staffAs: 'contributor' }, { globalRole: 'admin' }],
    invitation: { intendedRole: 'member' },
    extraRooms: ['Series B', 'Data room C'],
  },
};

test.describe('inviting a member', () => {
  /*
   * THE JOURNEY, END TO END, THROUGH THE REAL FORM.
   *
   * The invitation's role is chosen HERE, in this form, and the server records it on the
   * invitation so acceptance grants exactly what was authorized. Nothing below asserts SQL:
   * what needs proving in a browser is that the typed address and the chosen role reach the
   * server together, that the new row appears as an invitation rather than as a member, and
   * that the form clears so a second invitation does not inherit the first one's address.
   */
  test('invites an address as an Admin and shows it as invited, not as a member', async ({
    page,
  }) => {
    await openMembers(page);
    await page.getByLabel('Email address').fill('newcomer@example.com');
    await page.getByLabel('Role on arrival').selectOption('admin');
    await page.getByRole('button', { name: 'Invite member' }).click();

    /* The status region, not a redirect: the administrator stays where they are and the
       register updates underneath them. */
    await expect(page.getByRole('status')).toContainText('Invitation sent');
    const invited = page.getByRole('row', { name: /newcomer@example\.com/u });
    await expect(invited).toBeVisible();
    /* An invited person has not signed in, so the row must not read like access. */
    await expect(invited).toContainText('Invited, not yet signed in');
    await expect(invited.getByRole('button', { name: /^Withdraw invitation/u })).toBeVisible();
    await expect(invited.getByRole('button', { name: /^Staff into rooms/u })).toHaveCount(0);

    /* Cleared, so the next invitation starts empty rather than re-sending this address. */
    await expect(page.getByLabel('Email address')).toHaveValue('');
  });

  /* An already-invited address is refused by the database as a duplicate. It reaches the
     Admin as a conflict they can act on; it used to arrive as HTTP 500. */
  test('reports an address that is already invited without claiming a fault', async ({
    page,
  }) => {
    await openMembers(page);
    /* Invited HERE rather than read off the seeded register: the suite shares one database,
       so a row matched by its label could belong to any earlier test. This owns both halves
       of the duplicate, so the refusal is provably about the address just used. */
    const address = `duplicate-${Date.now()}@example.com`;
    await page.getByLabel('Email address').fill(address);
    await page.getByRole('button', { name: 'Invite member' }).click();
    await expect(page.getByRole('status')).toContainText('Invitation sent');

    await page.getByLabel('Email address').fill(address);
    await page.getByRole('button', { name: 'Invite member' }).click();

    const alert = page.getByRole('alert').first();
    await expect(alert).toBeVisible();
    /* The designed conflict copy, and no SQLSTATE or database wording. Also NOT room copy:
       this surface has no room, and the shared 409 message used to say one had changed. */
    await expect(alert).toContainText('Reload to see the current state');
    await expect(alert).not.toContainText('room');
    await expect(alert).not.toContainText('23505');
  });

  test('explains an address that is not an email instead of sending it', async ({ page }) => {
    await openMembers(page);
    const email = page.getByLabel('Email address');
    await email.fill('not-an-address');

    /*
     * The control stays ENABLED and explains on attempt. A button that silently disables
     * itself gives a keyboard or screen-reader user nothing to act on: they reach a dead
     * control with no stated reason. Pressing it names the problem and marks the field.
     */
    const submit = page.getByRole('button', { name: 'Invite member' });
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect(page.getByText('Enter an email address')).toBeVisible();
    await expect(email).toHaveAttribute('aria-invalid', 'true');
    /* Not sent, so nothing was invited and the typed value survives for correction. */
    await expect(page.getByRole('status')).not.toContainText('Invitation sent');
    await expect(email).toHaveValue('not-an-address');
  });
});

test.describe('the member register', () => {
  test('names an invitation as invited and offers only withdrawal', async ({ page }) => {
    await openMembers(page, POPULATED);
    /*
     * `.first()`, because the register is one page of 50 subjects ordered newest-first and
     * this suite shares a database: any earlier test that invited someone also has a row
     * matching this label. Asserting a single match made the case depend on how many
     * invitations happened to exist, which is not what it is testing.
     */
    const invited = page.getByRole('row', { name: /Invited, not yet signed in/u }).first();
    await expect(invited).toBeVisible();
    await expect(invited.getByRole('button', { name: /^Withdraw invitation/u })).toBeVisible();
    await expect(invited.getByRole('button', { name: /^Staff into rooms/u })).toHaveCount(0);
    await expect(invited.getByRole('button', { name: /^Disable/u })).toHaveCount(0);
  });

  test('offers the Owner no role, access, or transfer control on their own row', async ({
    page,
  }) => {
    await openMembers(page, POPULATED);
    const owner = page.getByRole('row', {
      name: /is the only role that can transfer ownership/u,
    });
    await expect(owner).toBeVisible();
    await expect(owner.getByRole('button', { name: /^Make Member/u })).toHaveCount(0);
    await expect(owner.getByRole('button', { name: /^Disable/u })).toHaveCount(0);
  });
});

test.describe('an Admin', () => {
  async function openAsAdmin(page: Page): Promise<string> {
    const seeded = await openMembers(page, {
      globalRole: 'admin',
      roomTitle: 'Series A',
      withColleagues: {
        members: [{ globalRole: 'member', staffAs: 'contributor' }, { globalRole: 'admin' }],
        invitation: { intendedRole: 'member' },
      },
    });
    return seeded.emailDisplay;
  }

  test('is offered no ownership transfer anywhere, because transfer is Owner-only', async ({
    page,
  }) => {
    await openAsAdmin(page);
    await expect(page.getByRole('button', { name: /^Transfer ownership/u })).toHaveCount(0);
  });

  test('is offered no role, state, or rooms control on their own row', async ({ page }) => {
    const own = await openAsAdmin(page);
    const ownRow = page.getByRole('row', { name: new RegExp(own, 'u') });
    await expect(ownRow).toBeVisible();
    for (const control of [/^Make Member/u, /^Make Admin/u, /^Disable/u, /^Staff into rooms/u])
      await expect(ownRow.getByRole('button', { name: control })).toHaveCount(0);
  });

  test('can still administer a plain Member', async ({ page }) => {
    await openAsAdmin(page);
    const member = page
      .getByRole('row', { name: /Reaches only the rooms they are staffed into/u })
      .first();
    await expect(member.getByRole('button', { name: /^Staff into rooms/u })).toBeVisible();
    await expect(member.getByRole('button', { name: /^Disable/u })).toBeVisible();
    await expect(member.getByRole('button', { name: /^Transfer ownership/u })).toHaveCount(0);
  });

  test('has no accessibility violations on the Members surface', async ({ page }) => {
    await openAsAdmin(page);
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe('a plain Member', () => {
  test('is offered no Administration destination at all', async ({ page }) => {
    const seeded = await server.signInMember({ globalRole: 'member', roomTitle: 'Series A' });
    await page.context().addCookies(
      seeded.cookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        url: cookie.url,
      })),
    );
    await page.goto(server.baseUrl);
    await expect(page.getByRole('heading', { level: 1, name: 'Rooms' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Administration', exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByRole('navigation', { name: /views/iu })).toHaveCount(0);
  });
});

test.describe('the room assignment dialog', () => {
  async function openAssignment(page: Page): Promise<void> {
    await page
      .getByRole('button', { name: /^Staff into rooms/u })
      .first()
      .click();
    await expect(page.getByRole('dialog')).toBeVisible();
  }

  test('traps focus and returns it to the row control on cancel', async ({ page }) => {
    await openMembers(page, POPULATED);
    const trigger = page.getByRole('button', { name: /^Staff into rooms/u }).first();
    await trigger.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('keeps the draft and the dialog open when the batch is refused', async ({ page }) => {
    await openMembers(page, POPULATED);
    await openAssignment(page);
    const dialog = page.getByRole('dialog');

    const selects = dialog.locator('select');
    await selects.nth(0).selectOption('manager');
    await selects.nth(1).selectOption('contributor');

    await page.route('**/api/members/actions', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'CONFLICT',
            message:
              'The resource changed before this request completed. Reload and try again.',
          },
        }),
      }),
    );
    await dialog.getByRole('button', { name: 'Save rooms' }).click();

    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('alert')).toContainText('Someone else changed this');
    await expect(selects.nth(0)).toHaveValue('manager');
    await expect(selects.nth(1)).toHaveValue('contributor');
    await expect(dialog.getByRole('button', { name: 'Save rooms' })).toBeEnabled();
  });

  test('cannot be dismissed while the batch is in flight', async ({ page }) => {
    await openMembers(page, POPULATED);
    await openAssignment(page);
    const dialog = page.getByRole('dialog');
    await dialog.locator('select').first().selectOption('manager');

    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/members/actions', async (route) => {
      await held;
      await route.continue();
    });
    await dialog.getByRole('button', { name: 'Save rooms' }).click();

    await expect(dialog.getByRole('button', { name: 'Saving rooms…' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await page.mouse.click(2, 2);
    await expect(dialog).toBeVisible();

    release();
  });

  test('closes on a committed batch and returns focus to the row control', async ({ page }) => {
    await openMembers(page, POPULATED);
    const trigger = page.getByRole('button', { name: /^Staff into rooms/u }).first();
    await trigger.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.locator('select').first().selectOption('manager');
    await dialog.getByRole('button', { name: 'Save rooms' }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByRole('status')).toContainText('Rooms updated');
    await expect(trigger).toBeFocused();
  });

  test('does not open holding a failure from a different operation', async ({ page }) => {
    await openMembers(page, POPULATED);
    await page.route('**/api/members/actions', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'CONFLICT',
            message:
              'The resource changed before this request completed. Reload and try again.',
          },
        }),
      }),
    );
    await page
      .getByRole('button', { name: /^Make Admin/u })
      .first()
      .click();
    await expect(page.getByRole('alert').first()).toContainText('Someone else changed this');

    await page.unroute('**/api/members/actions');
    await page
      .getByRole('button', { name: /^Staff into rooms/u })
      .first()
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
  });

  test('says when the room list is partial and offers the rest inside the dialog', async ({
    page,
  }) => {
    await page.route('**/api/rooms*', async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as {
        rooms: readonly { readonly title: string; readonly roomId: string }[];
      };
      const first = body.rooms.slice(0, 1);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          rooms: first,
          ...(first[0] === undefined
            ? {}
            : { nextCursor: { title: first[0].title, roomId: first[0].roomId } }),
        }),
      });
    });
    await openMembers(page, POPULATED);
    await page
      .getByRole('button', { name: /^Staff into rooms/u })
      .first()
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Only part of the room list loaded');
    await expect(dialog.getByRole('button', { name: 'Load more rooms' })).toBeVisible();
  });
});

test.describe('the register continues past the first page', () => {
  test('offers and follows a continuation rather than stopping at a prefix', async ({
    page,
  }) => {
    let request = 0;
    await page.route('**/api/rooms*', async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as {
        rooms: readonly { readonly title: string; readonly roomId: string }[];
      };
      const index = request;
      request += 1;
      const room = body.rooms[index];
      const following = body.rooms[index + 1];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          rooms: room === undefined ? [] : [room],
          ...(following === undefined || room === undefined
            ? {}
            : { nextCursor: { title: room.title, roomId: room.roomId } }),
        }),
      });
    });
    const seeded = await server.signInMember(POPULATED);
    await page.context().addCookies(
      seeded.cookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        url: cookie.url,
      })),
    );
    await page.goto(server.baseUrl);

    await expect(
      page.getByRole('status').filter({ hasText: 'part of your rooms' }),
    ).toBeVisible();
    const more = page.getByRole('button', { name: 'Load more rooms' });
    await expect(more).toBeVisible();
    await more.click();
    await expect(page.getByRole('row')).toHaveCount(3);
  });
});

test.describe('at 320 CSS pixels', () => {
  test.use({ viewport: { width: 320, height: 720 } });

  test('labels every stacked cell and keeps the real column headers', async ({ page }) => {
    await openMembers(page, POPULATED);
    const headers = page.locator('table thead th');
    await expect(headers.first()).toBeAttached();
    const labels = await page.evaluate(() => {
      const cells = [...document.querySelectorAll('tbody [data-label]')];
      return cells.map((cell) => ({
        label: cell.getAttribute('data-label') ?? '',
        generated: getComputedStyle(cell, '::before').content,
      }));
    });
    expect(labels.length).toBeGreaterThan(4);
    for (const { label, generated } of labels) {
      expect(label).not.toBe('');
      expect(generated).toContain(label);
    }
  });

  test('does not overflow the viewport horizontally', async ({ page }) => {
    await openMembers(page, POPULATED);
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  });

  test('keeps the transfer preview table readable and labelled', async ({ page }) => {
    await openMembers(page, POPULATED);
    await page
      .getByRole('button', { name: /^Transfer ownership/u })
      .first()
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('You become an Admin');
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  });

  test('has no accessibility violations with a populated table', async ({ page }) => {
    await openMembers(page, POPULATED);
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

  test('has no accessibility violations with the assignment dialog open', async ({ page }) => {
    await openMembers(page, POPULATED);
    await page
      .getByRole('button', { name: /^Staff into rooms/u })
      .first()
      .click();
    await expect(page.getByRole('dialog')).toBeVisible();
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

  /*
   * DARK THEME IS A SEPARATE RUN, NOT AN ASSUMPTION.
   *
   * Every colour pair is different here, so contrast is the one class of violation the light
   * run cannot speak to — and this surface is unusually dependent on it: role and state are
   * carried by badges, a busy row is dimmed, and a refusal is a tinted notice. The dialog is
   * opened in the same pass because its overlay and surface sit on different tokens again.
   */
  test('reports zero axe violations on the populated surface in dark theme', async ({
    page,
  }) => {
    await settleTheme(page, 'dark');
    await openMembers(page, POPULATED);
    const table = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(table.violations.map((violation) => violation.id)).toEqual([]);

    await page
      .getByRole('button', { name: /^Staff into rooms/u })
      .first()
      .click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const dialog = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(dialog.violations.map((violation) => violation.id)).toEqual([]);
  });
});
