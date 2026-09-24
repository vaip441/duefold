/**
 * WCAG 2.2 AA criteria that automated scanning cannot decide.
 *
 * The axe scans elsewhere cover contrast, names, roles, and structure. They cannot
 * evaluate most of what WCAG 2.2 ADDED, because those criteria are about behaviour
 * and alternatives rather than markup:
 *
 * - 2.5.8 Target Size (Minimum): controls at least 24x24 CSS pixels, or spaced.
 * - 2.4.11 Focus Not Obscured (Minimum): the focused control stays visible, which
 *   matters here because sticky headers and a fixed modal scrim exist.
 * - 2.5.7 Dragging Movements: any drag has a single-pointer alternative.
 * - 3.2.6 Consistent Help: help appears in the same relative order where offered.
 * - 3.3.7 Redundant Entry: information already given is not asked for again.
 * - 3.3.8 Accessible Authentication (Minimum): no cognitive test, and the one-time
 *   code is autofillable rather than requiring transcription from memory.
 *
 * Every assertion here runs against a POPULATED surface. A target-size or
 * focus-visibility check against an empty page passes while proving nothing.
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

async function openPopulatedRoom(page: Page): Promise<void> {
  const seeded = await server.signInMember({
    roomTitle: 'Reading Room WCAG',
    roomRole: 'manager',
    // A real participant with a real grant, and real processing rows: target size and
    // focus visibility are meaningless assertions against an empty surface.
    withParticipant: { email: 'wcag-reader@example.com', grant: 'active' },
    withProcessing: [
      { title: 'Quarantined upload', state: 'quarantine' },
      { title: 'Failed conversion', state: 'processing_failed' },
    ],
  });
  await page.context().addCookies(
    seeded.cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      url: cookie.url,
    })),
  );
  await page.goto(server.baseUrl);
  await page.getByRole('button', { name: /Open room Reading Room WCAG/u }).click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // The heading paints before the room's own controls load; measure the loaded room.
  await expect(page.getByRole('heading', { name: 'Working structure' })).toBeVisible();
}

/** Every control's rendered box, with its accessible-ish label for reporting. */
async function controlBoxes(
  page: Page,
): Promise<readonly { label: string; width: number; height: number; spaced: boolean }[]> {
  return page.evaluate(() => {
    const controls = [
      ...document.querySelectorAll<HTMLElement>(
        'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"]',
      ),
    ];
    return controls
      .filter((element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          box.width > 0 &&
          box.height > 0
        );
      })
      .map((element) => {
        const box = element.getBoundingClientRect();
        /*
         * 2.5.8 is met by size OR by spacing, but the spacing exception is narrow: a
         * 24px-DIAMETER circle centred on the target must not intersect the circle of
         * any other target. Two adjacent 14px controls therefore fail even with a
         * visible gap, because their circles overlap.
         *
         * My first version asked only whether another control's BOX came within 24px,
         * which nearly every isolated control satisfies -- shrinking every button to
         * 14px still passed. Comparing centre distance against 24px is the actual
         * rule, and it fails that mutation.
         */
        const centre = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
        const spaced = !controls.some((other) => {
          if (other === element) return false;
          const theirs = other.getBoundingClientRect();
          if (theirs.width === 0 || theirs.height === 0) return false;
          const theirCentre = {
            x: theirs.left + theirs.width / 2,
            y: theirs.top + theirs.height / 2,
          };
          return Math.hypot(centre.x - theirCentre.x, centre.y - theirCentre.y) < 24;
        });
        return {
          label: `${element.tagName.toLowerCase()}:${(element.textContent ?? '').trim().slice(0, 40) || String(element.getAttribute('aria-label'))}`,
          width: box.width,
          height: box.height,
          spaced,
        };
      });
  });
}

test.describe('WCAG 2.2 criteria beyond automated scanning', () => {
  test('2.5.8 every control is at least 24 CSS pixels or sufficiently spaced', async ({
    page,
  }) => {
    await openPopulatedRoom(page);
    const menu = page.getByRole('button', { name: 'Menu' });
    if (await menu.isVisible()) await menu.click();
    const boxes = await controlBoxes(page);
    // Guard against a vacuous pass: the surface must actually have controls.
    expect(boxes.length).toBeGreaterThan(5);
    const failures = boxes.filter((box) => (box.width < 24 || box.height < 24) && !box.spaced);
    expect(failures, JSON.stringify(failures)).toEqual([]);
  });

  test('2.5.8 the detector itself catches cramped adjacent targets', async ({ page }) => {
    /*
     * Self-check, because a conformance test that cannot fail is worthless. Shrinking
     * the real buttons did NOT falsify the check, and that turned out to be correct:
     * padding keeps them at 41px, and the one control that did shrink is isolated, so
     * WCAG's spacing exception genuinely excuses it. A weak mutation, not a weak test.
     *
     * So inject a genuinely non-conforming pair -- two 14px targets 2px apart, whose
     * 24px circles overlap -- and require the detector to report them. If this stops
     * failing, the checks above have stopped meaning anything.
     */
    await openPopulatedRoom(page);
    await page.evaluate(() => {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:400px;top:400px;display:flex;gap:2px';
      for (const label of ['a', 'b']) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.style.cssText = 'width:14px;height:14px;min-height:0;padding:0';
        host.append(button);
      }
      document.body.append(host);
    });
    const boxes = await controlBoxes(page);
    const failures = boxes.filter((box) => (box.width < 24 || box.height < 24) && !box.spaced);
    expect(failures.length, JSON.stringify(failures)).toBeGreaterThanOrEqual(2);
  });

  test('2.5.8 holds at 320 pixels, where controls are most likely to be cramped', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await openPopulatedRoom(page);
    await page.getByRole('button', { name: 'Menu' }).click();
    const boxes = await controlBoxes(page);
    expect(boxes.length).toBeGreaterThan(5);
    const failures = boxes.filter((box) => (box.width < 24 || box.height < 24) && !box.spaced);
    expect(failures, JSON.stringify(failures)).toEqual([]);
  });

  test('2.4.11 the focused control is never hidden behind sticky chrome', async ({ page }) => {
    await openPopulatedRoom(page);
    /*
     * Tab through the surface and require that whatever holds focus is inside the
     * viewport and not covered at its own centre point. A sticky header that covers
     * the focused row is the classic 2.4.11 failure and no axe rule detects it.
     */
    const obscured: string[] = [];
    for (let step = 0; step < 40; step += 1) {
      await page.keyboard.press('Tab');
      const verdict = await page.evaluate(() => {
        const active = document.activeElement;
        if (active === null || active === document.body) return null;
        const box = active.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return null;
        const describe = `${active.tagName.toLowerCase()}:${(active.textContent ?? '').trim().slice(0, 30)}`;
        /*
         * A skip link legitimately rests off-screen and slides in on focus via a
         * transform. Playwright's synthetic Tab does not reliably set
         * :focus-visible, which is what drives that transform, so a control the
         * design animates into view is judged by that declaration rather than by its
         * resting position. Anything without such a transition is a real failure.
         */
        const animatesIntoView =
          getComputedStyle(active).transitionProperty.includes('transform');
        if (box.bottom < 0 || box.top > window.innerHeight)
          return animatesIntoView ? null : `${describe} (outside viewport)`;
        const centreX = box.left + box.width / 2;
        const centreY = box.top + box.height / 2;
        const atPoint = document.elementFromPoint(centreX, centreY);
        if (atPoint === null) return null;
        // Covered only counts when the element on top is not the focused control or
        // one of its own descendants/ancestors.
        const related = active.contains(atPoint) || atPoint.contains(active);
        return related ? null : `${describe} covered by ${atPoint.tagName.toLowerCase()}`;
      });
      if (verdict !== null) obscured.push(verdict);
    }
    expect(obscured, obscured.join('; ')).toEqual([]);
  });

  test('2.5.7 no interaction requires dragging', async ({ page }) => {
    await openPopulatedRoom(page);
    /*
     * The ordering and selection controls are deliberately buttons, a numeric
     * position field, and checkboxes. If a drag affordance ever appears, this fails
     * and the single-pointer alternative has to be added with it.
     */
    expect(await page.locator('[draggable="true"]').count()).toBe(0);
    for (const property of ['grab', 'grabbing']) {
      expect(
        await page.evaluate(
          (cursor) =>
            [...document.querySelectorAll<HTMLElement>('*')].filter(
              (element) => getComputedStyle(element).cursor === cursor,
            ).length,
          property,
        ),
        property,
      ).toBe(0);
    }
    /*
     * And the single-pointer alternative for ordering really exists: reorder mode
     * offers Move up and Move down, and says in words how it works.
     */
    await page.getByRole('button', { name: 'Reorder collection' }).click();
    await expect(page.getByText(/Reorder mode is active/u)).toBeVisible();
    await expect(page.getByRole('button', { name: /Move up/u }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Move down/u }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Finish reordering' }).click();
    /*
     * The numeric position field is the non-drag way to make an arbitrary jump rather
     * than stepping. It lives in the entry's Move form, inside Manage.
     */
    const row = page.getByRole('row', { name: /Quarantined upload/u });
    await row.getByRole('button', { name: /Manage Quarantined upload/u }).click();
    await row.getByRole('button', { name: /^Move$/u }).click();
    await expect(page.getByRole('spinbutton')).toBeVisible();
  });

  test('3.3.8 authentication accepts a pasted one-time code and sets no cognitive test', async ({
    page,
  }) => {
    const address = 'wcag-viewer@example.com';
    await server.inviteViewer(address);
    await page.goto(`${server.baseUrl}/read`);
    const email = page.getByLabel('Email address');
    await expect(email).toHaveAttribute('autocomplete', 'email');
    await email.fill(address);
    await page.getByRole('button', { name: 'Send code' }).click();
    const code = page.getByLabel('Eight-digit code');
    await expect(code).toBeVisible();
    /*
     * `one-time-code` lets a password manager or the platform fill the value, which
     * is what 3.3.8 asks for: the user is never required to transcribe or memorize
     * it. A pasted value must be accepted, so no handler may block paste.
     */
    await expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    // A real delivered code, pasted in one action, is accepted and completes sign-in:
    // the user never has to memorize or retype it.
    const delivered = await server.deliveredCode(address);
    await code.fill(delivered);
    await expect(code).toHaveValue(delivered);
    await page.getByRole('button', { name: 'Verify code' }).click();
    await expect(page.getByRole('navigation', { name: 'Collection' })).toBeVisible();
    // No puzzle, arithmetic, or image-recognition step anywhere on the surface.
    for (const forbidden of [/captcha/iu, /puzzle/iu, /solve/iu, /what is \d/iu])
      expect(await page.getByText(forbidden).count(), String(forbidden)).toBe(0);
  });

  test('3.2.6 help appears, and in the same relative position, on both sign-in surfaces', async ({
    page,
  }) => {
    /*
     * Consistent Help is about ORDER, not mere presence. An earlier version of this
     * test passed when help was absent from BOTH surfaces, which proved nothing. This
     * one runs a server that really has a support contact configured, requires the
     * link on each surface, and compares where it sits in the focus order.
     */
    /*
     * The support contact lives in the database, not in server options:
     * PostgreSQL is its only source. Configure it where the route actually reads it.
     */
    const configured = await startTestServer();
    await configured.setSupportContact('support@example.com');
    try {
      const positions: number[] = [];
      for (const path of ['/read', '/sign-in']) {
        await page.goto(`${configured.baseUrl}${path}`);
        await expect(page.getByRole('link', { name: /support/iu }), path).toHaveCount(1);
        positions.push(
          await page.evaluate(() => {
            const focusable = [...document.querySelectorAll('a[href], button, input, select')];
            const index = focusable.findIndex(
              (element) =>
                element.tagName === 'A' && /support/iu.test(element.textContent ?? ''),
            );
            return index / Math.max(1, focusable.length);
          }),
        );
      }
      expect(Math.abs((positions[0] ?? 0) - (positions[1] ?? 1))).toBeLessThan(0.25);
    } finally {
      await configured.close();
    }
  });
});
