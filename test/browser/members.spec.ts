/**
 * The Members surface in a real browser.
 *
 * Everything asserted here needs a live DOM and cannot be reached by server-rendered
 * markup, which is why the unit suite deliberately stops short of it: the assignment
 * dialog is a Base UI portal that renders nothing on the server, so its pending label,
 * dismissal suppression, draft survival, focus return, and the CSS-generated stacked labels
 * were all claims no test could check.
 *
 * Every session is genuinely server-issued and every seeded colleague, invitation and
 * assignment is created through the audited SECURITY DEFINER functions the product uses, so
 * a passing case says something about what the server actually permits rather than about
 * what the client chose to render.
 *
 * The properties under test are the ones an administrator's decisions depend on:
 *   - a refused batch keeps the dialog OPEN with the draft intact, because a multi-room
 *     choice must not have to be reconstructed from memory;
 *   - the dialog cannot be dismissed while the batch is in flight, because closing
 *     mid-request would leave a sign-out unreported;
 *   - a committed batch closes it and returns focus to the row control that opened it;
 *   - a failure from one operation never appears inside another operation's dialog;
 *   - at 320 CSS pixels the stacked tables label every cell and nothing overflows.
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

/** Signs in an Owner and opens the Members workbench. */
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
  await page.getByRole('button', { name: 'Members', exact: true }).click();
  /* The section heading, not the frame title: both read "Members" once the workbench is
     open, which is correct — the frame names the surface and the section names itself. */
  await expect(page.getByRole('heading', { level: 2, name: 'Members' })).toBeVisible();
  return seeded;
}

/** The populated fixture: two colleagues, a pending invitation, several rooms. */
const POPULATED: Parameters<TestServer['signInMember']>[0] = {
  globalRole: 'owner',
  roomTitle: 'Series A',
  withColleagues: {
    members: [{ globalRole: 'member', staffAs: 'contributor' }, { globalRole: 'admin' }],
    invitation: { intendedRole: 'member' },
    extraRooms: ['Series B', 'Data room C'],
  },
};

test.describe('the member register', () => {
  test('names an invitation as invited and offers only withdrawal', async ({ page }) => {
    await openMembers(page, POPULATED);
    const invited = page.getByRole('row', { name: /Invited, not yet signed in/u });
    await expect(invited).toBeVisible();
    /* An invitation holds nothing, so no role, access, or room control may act on it. */
    await expect(invited.getByRole('button', { name: /^Withdraw invitation/u })).toBeVisible();
    await expect(invited.getByRole('button', { name: /^Staff into rooms/u })).toHaveCount(0);
    await expect(invited.getByRole('button', { name: /^Disable/u })).toHaveCount(0);
  });

  test('offers the Owner no role, access, or transfer control on their own row', async ({
    page,
  }) => {
    // Ownership moves only through the audited transfer and the Owner cannot be disabled.
    await openMembers(page, POPULATED);
    /* Located by the Owner's own role explanation. A bare /Owner/ would also match an
       Admin row, which carries "Owners and Admins already reach every room". */
    const owner = page.getByRole('row', {
      name: /is the only role that can transfer ownership/u,
    });
    await expect(owner).toBeVisible();
    await expect(owner.getByRole('button', { name: /^Make Member/u })).toHaveCount(0);
    await expect(owner.getByRole('button', { name: /^Disable/u })).toHaveCount(0);
  });
});

test.describe('the room assignment dialog', () => {
  /** Opens the assignment dialog for the staffed plain Member. */
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
    /* Cancel takes initial focus: the panel opens on a task that signs someone out, so
       the first control should be the one that leaves it. */
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('keeps the draft and the dialog open when the batch is refused', async ({ page }) => {
    await openMembers(page, POPULATED);
    await openAssignment(page);
    const dialog = page.getByRole('dialog');

    // A multi-room draft, which is exactly what a premature close would discard.
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

    /* Open, with the refusal reported INSIDE it and both choices still selected. The
       dialog used to close on submit, so a refusal dropped the administrator back to the
       table having lost a draft they would have to rebuild from memory. */
    await expect(dialog).toBeVisible();
    /* The surface's own designed copy, not the server's wording: a 409 on a batch means
       someone else changed the room while this draft was being made. */
    await expect(dialog.getByRole('alert')).toContainText('Someone else changed this room');
    await expect(selects.nth(0)).toHaveValue('manager');
    await expect(selects.nth(1)).toHaveValue('contributor');
    // Still submittable, so the same draft can be retried rather than re-entered.
    await expect(dialog.getByRole('button', { name: 'Save rooms' })).toBeEnabled();
  });

  test('cannot be dismissed while the batch is in flight', async ({ page }) => {
    await openMembers(page, POPULATED);
    await openAssignment(page);
    const dialog = page.getByRole('dialog');
    await dialog.locator('select').first().selectOption('manager');

    // Held open so the pending state is observable rather than a render that never paints.
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/members/actions', async (route) => {
      await held;
      await route.continue();
    });
    await dialog.getByRole('button', { name: 'Save rooms' }).click();

    // The pending label, which could never be observed while the dialog closed on submit.
    await expect(dialog.getByRole('button', { name: 'Saving rooms…' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    /* Escape and an outside click are both suppressed: closing mid-request would leave an
       irreversible sign-out unreported. */
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

    /* Closed only by a CONFIRMED batch. Focus returns explicitly, because a programmatic
       close unmounts the popup while focus is inside it, which would otherwise drop focus
       to the document and make a keyboard user restart from the top of the page. */
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('status')).toContainText('Rooms updated');
    await expect(trigger).toBeFocused();
  });

  test('does not open holding a failure from a different operation', async ({ page }) => {
    /*
     * `changeFailure` is shared by role, state and assignment operations. Passing it
     * through unconditionally meant a failed role change appeared inside a freshly opened
     * assignment dialog, as though the draft on screen had been rejected.
     */
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
    // Fail a ROLE change, which reports at the table.
    await page
      .getByRole('button', { name: /^Make Admin/u })
      .first()
      .click();
    await expect(page.getByRole('alert').first()).toContainText(
      'Someone else changed this room',
    );

    await page.unroute('**/api/members/actions');
    await page
      .getByRole('button', { name: /^Staff into rooms/u })
      .first()
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // The dialog carries no alert: that refusal was not about this draft.
    await expect(dialog.getByRole('alert')).toHaveCount(0);
  });

  test('says when the room list is partial and offers the rest inside the dialog', async ({
    page,
  }) => {
    /*
     * The register is paged. It used to be walked to a 100-page cap and stored as terminal,
     * so this caveat named a limitation with no way past it and rooms beyond the cap could
     * not be staffed at all.
     */
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
    // The action that resolves the caveat, beside the caveat itself.
    await expect(dialog.getByRole('button', { name: 'Load more rooms' })).toBeVisible();
  });
});

test.describe('the register continues past the first page', () => {
  test('offers and follows a continuation rather than stopping at a prefix', async ({
    page,
  }) => {
    /* One room per page, so the continuation is exercised rather than asserted against a
       collection that fits in a single response. */
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

    // A prefix says it is one, and offers the request that completes it.
    await expect(
      page.getByRole('status').filter({ hasText: 'part of your rooms' }),
    ).toBeVisible();
    const more = page.getByRole('button', { name: 'Load more rooms' });
    await expect(more).toBeVisible();
    await more.click();
    // The next page is appended; the rooms already read are not discarded.
    await expect(page.getByRole('row')).toHaveCount(3);
  });
});

test.describe('at 320 CSS pixels', () => {
  test.use({ viewport: { width: 320, height: 720 } });

  test('labels every stacked cell and keeps the real column headers', async ({ page }) => {
    await openMembers(page, POPULATED);
    /*
     * The stacked layout's labels are CSS-generated content from `data-label`, which only
     * a real browser resolves. The `<th scope="col">` headers stay in the DOM, visually
     * hidden rather than `display:none`, so the programmatic association survives.
     */
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
      // The column name is actually painted, not merely present as an attribute.
      expect(generated).toContain(label);
    }
  });

  test('does not overflow the viewport horizontally', async ({ page }) => {
    await openMembers(page, POPULATED);
    /* A horizontally scrolling table would put the row action buttons off-screen at this
       width, which is why the register stacks instead. */
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  });

  test('keeps the transfer preview table readable and labelled', async ({ page }) => {
    await openMembers(page, POPULATED);
    /* The transfer dialog is where an Owner approves an irreversible privilege loss, and it
       stacks like every other register at this width. */
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
});
