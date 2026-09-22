/**
 * What a screen reader is told about the confirmations that guard irreversible or
 * access-widening changes.
 *
 * Automated accessibility scanning cannot decide announcement ORDER, and the order is the
 * thing that matters here: a person who hears "type SCHEDULE ROOM PURGE" before hearing what
 * a purge destroys has been asked to consent to something they have not been told. These
 * cases read the accessibility tree — the same structure a reader narrates — and pin the
 * sequence, the accessible names, and that a refusal is an alert rather than silent text.
 *
 * This is not a substitute for a human listening to a real screen reader, which remains open
 * in `docs/release-evidence.md`. It is the part of that review a machine can hold.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { startTestServer, type TestServer } from '../support/browser-server.ts';
import { archiveRoom, markStructurePublished } from '../support/room-seeding.ts';

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

/** The dialog's tree as a reader walks it, one entry per line. */
async function narration(dialog: Locator): Promise<string[]> {
  return (await dialog.ariaSnapshot())
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function indexOf(lines: readonly string[], pattern: RegExp): number {
  return lines.findIndex((line) => pattern.test(line));
}

/**
 * The rule every reviewed confirmation must satisfy, whatever it guards: the dialog is
 * announced by its own title, the consequence is reached before the field that unlocks the
 * action, and the field names the exact phrase rather than describing it.
 */
async function assertConsequenceBeforeField(
  dialog: Locator,
  options: { readonly title: string; readonly phrase: string; readonly consequence: RegExp },
): Promise<void> {
  // The consequence comes from the server's review, which arrives after the dialog opens.
  await expect(dialog).toContainText(options.consequence);
  const lines = await narration(dialog);
  expect(lines[0], 'the dialog is announced by its accessible name').toContain(
    `dialog "${options.title}"`,
  );
  expect(indexOf(lines, new RegExp(`heading "${options.title}"`, 'u'))).toBeGreaterThan(0);

  const consequence = indexOf(lines, options.consequence);
  const field = indexOf(lines, /^- textbox /u);
  expect(consequence, 'the consequence must be present').toBeGreaterThan(0);
  expect(field, 'the confirmation field must be present').toBeGreaterThan(0);
  expect(
    consequence,
    'a reader must hear what the action does before reaching the field that unlocks it',
  ).toBeLessThan(field);

  /* The label names the phrase, so it can be typed without seeing the screen. */
  expect(lines[field]).toContain(options.phrase);
  const submit = indexOf(lines, /^- button .*\[disabled\]/u);
  expect(submit, 'the action stays disabled until the phrase is typed').toBeGreaterThan(field);
}

test.describe('what a reader is told before confirming', () => {
  /*
   * Publication is the change that makes a room visible to outside readers, and the review
   * carries the reach the server counted. Both the reach and the fresh-sign-in requirement
   * must be heard before the field.
   */
  test('publication states its reach and its sign-in requirement first', async ({ page }) => {
    const seeded = await signIn(page, {
      globalRole: 'member',
      roomTitle: 'Narrated publication',
      roomRole: 'manager',
      withParticipant: { email: 'narration.reader@example.test', grant: 'active' },
    });
    if (seeded.roomId === null) throw new Error('room not seeded');
    await markStructurePublished(server.migrationPool, seeded.roomId);

    await page.getByRole('button', { name: /Open room Narrated publication/u }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Publish room' }).click();
    const dialog = page.getByRole('dialog', { name: 'Publish this room' });

    await assertConsequenceBeforeField(dialog, {
      title: 'Publish this room',
      phrase: 'PUBLISH ROOM',
      consequence: /Viewers who gain access/u,
    });
    const lines = await narration(dialog);
    expect(
      indexOf(lines, /sign-in from the last 15 minutes/u),
      'the sign-in requirement is stated before the field, not after a refusal',
    ).toBeLessThan(indexOf(lines, /^- textbox /u));
  });

  /*
   * A purge destroys everything in the room. What is destroyed, and what survives it, must
   * both be heard: a reader who is told only "this is permanent" cannot tell whether the
   * audit trail goes with it.
   */
  test('a purge states what it destroys and what survives it', async ({ page }) => {
    const seeded = await signIn(page, { globalRole: 'owner', roomTitle: 'Narrated purge' });
    if (seeded.roomId === null) throw new Error('room not seeded');
    await archiveRoom(server.migrationPool, seeded.roomId);

    await page.getByRole('button', { name: /Open room Narrated purge/u }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Schedule purge' }).click();
    const dialog = page.getByRole('dialog', { name: 'Schedule a purge of this room' });

    await assertConsequenceBeforeField(dialog, {
      title: 'Schedule a purge of this room',
      phrase: 'SCHEDULE ROOM PURGE',
      consequence: /permanently deleted/u,
    });
    const lines = await narration(dialog);
    expect(indexOf(lines, /audit records remain/u)).toBeGreaterThan(0);
    expect(indexOf(lines, /backups follow their own retention/u)).toBeGreaterThan(0);
  });

  /*
   * Allowing downloads installation-wide widens every inheriting room at once, so the reach
   * it was reviewed against is part of the consequence rather than a detail beside it.
   */
  test('the installation download default states its reach first', async ({ page }) => {
    await signIn(page, { globalRole: 'owner' });
    await page.getByRole('button', { name: 'Administration', exact: true }).click();
    await page
      .getByRole('navigation', { name: 'Administration sections' })
      .getByRole('button', { name: 'Installation', exact: true })
      .click();
    await page.getByRole('button', { name: 'Allow original downloads' }).click();
    const dialog = page.getByRole('dialog', {
      name: 'Allow original downloads installation-wide',
    });

    await assertConsequenceBeforeField(dialog, {
      title: 'Allow original downloads installation-wide',
      phrase: 'ALLOW ORIGINAL DOWNLOADS',
      consequence: /room|document/u,
    });
  });

  /*
   * A mistyped phrase must be announced, not merely styled. A reader who hears nothing is
   * left at a disabled button with no stated reason, which is the failure a disabled control
   * alone produces.
   */
  test('a mistyped phrase is announced as an alert, and an untouched field is not', async ({
    page,
  }) => {
    const seeded = await signIn(page, { globalRole: 'owner', roomTitle: 'Narrated refusal' });
    if (seeded.roomId === null) throw new Error('room not seeded');
    await archiveRoom(server.migrationPool, seeded.roomId);

    await page.getByRole('button', { name: /Open room Narrated refusal/u }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Schedule purge' }).click();
    const dialog = page.getByRole('dialog', { name: 'Schedule a purge of this room' });

    /* Nothing typed yet: an error beside an untouched field would be noise. */
    await expect(dialog.getByRole('textbox')).toBeVisible();
    expect(await narration(dialog), 'an untouched field carries no alert').not.toContainEqual(
      expect.stringMatching(/^- alert:/u),
    );

    await dialog.getByRole('textbox').fill('SCHEDULE ROOM');
    const mistyped = await narration(dialog);
    const alert = indexOf(mistyped, /^- alert:/u);
    expect(alert, 'the refusal is announced').toBeGreaterThan(0);
    expect(mistyped[indexOf(mistyped, /^- textbox /u)]).toContain('[invalid]');
    expect(
      alert,
      'the alert follows the field it is about, so a reader hears it in context',
    ).toBeGreaterThan(indexOf(mistyped, /^- textbox /u));

    /* Correcting it withdraws the alert rather than leaving a stale refusal announced. */
    await dialog.getByRole('textbox').fill('SCHEDULE ROOM PURGE');
    expect(await narration(dialog)).not.toContainEqual(expect.stringMatching(/^- alert:/u));
  });

  /*
   * Cancel takes initial focus on every destructive confirmation, so a reader pressing Enter
   * on arrival leaves rather than acts, and Escape returns focus to the control that opened
   * the dialog rather than dropping it to the document.
   */
  test('Cancel holds initial focus and Escape returns focus to the opening control', async ({
    page,
  }) => {
    const seeded = await signIn(page, { globalRole: 'owner', roomTitle: 'Narrated focus' });
    if (seeded.roomId === null) throw new Error('room not seeded');
    await archiveRoom(server.migrationPool, seeded.roomId);

    await page.getByRole('button', { name: /Open room Narrated focus/u }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const opener = page.getByRole('button', { name: 'Schedule purge' });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Schedule a purge of this room' });
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });
});
