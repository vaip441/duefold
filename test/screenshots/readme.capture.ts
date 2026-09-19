/**
 * README screenshots, captured from the real server in the browser test harness.
 *
 * Every organization, person, and document shown is synthetic. The document page is
 * rendered here from the HTML below and served as the preview image. The production
 * sandboxed compositor applies the viewer watermark before capture.
 */

import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { startTestServer, type TestServer } from '../support/browser-server.ts';

const OUT = fileURLToPath(new URL('../../docs/images/', import.meta.url));
const ROOM = 'Series A diligence';
const DOCUMENT = 'Q3 investor update';
// The README grid shows four images in two rows. Every grid image is captured
// at this one 16:10 size so cells, rows, and captions line up at any width.
const GRID = { width: 1200, height: 750 };

const SYNTHETIC_PAGE = `<!doctype html>
<html><head><style>
  body { margin: 0; width: 1200px; height: 1600px; background: #fff; color: #1c1f1e;
    font: 22px/1.55 Georgia, 'Source Serif 4', serif; }
  main { padding: 120px 130px; }
  .kicker { font: 600 16px/1 system-ui, sans-serif; letter-spacing: .14em; text-transform: uppercase; color: #5a625d; }
  h1 { font-size: 54px; line-height: 1.15; margin: 22px 0 10px; font-weight: 600; }
  .sub { color: #5a625d; margin: 0 0 56px; }
  .kpis { display: grid; grid-template-columns: repeat(3, 1fr); border-top: 2px solid #1c1f1e; border-bottom: 1px solid #c9cfca; margin-bottom: 56px; }
  .kpis div { padding: 26px 0; }
  .kpis b { display: block; font-size: 44px; font-weight: 600; }
  .kpis span { font: 16px/1.3 system-ui, sans-serif; color: #5a625d; }
  h2 { font-size: 28px; margin: 0 0 14px; }
  table { width: 100%; border-collapse: collapse; font: 19px/1.4 system-ui, sans-serif; margin: 10px 0 48px; }
  th, td { text-align: right; padding: 12px 0; border-bottom: 1px solid #e1e5e2; }
  th:first-child, td:first-child { text-align: left; }
  th { color: #5a625d; font-weight: 600; }
  footer { position: absolute; bottom: 90px; left: 130px; right: 130px; display: flex; justify-content: space-between;
    font: 15px/1 system-ui, sans-serif; color: #7a827d; border-top: 1px solid #e1e5e2; padding-top: 18px; }
</style></head><body><main>
  <div class="kicker">Larkspur Robotics · Investor update</div>
  <h1>Third quarter, 2026</h1>
  <p class="sub">Prepared for existing and prospective Series A investors.</p>
  <div class="kpis">
    <div><b>€1.84m</b><span>Annual recurring revenue</span></div>
    <div><b>+38%</b><span>Quarter-on-quarter growth</span></div>
    <div><b>21 mo</b><span>Runway at current burn</span></div>
  </div>
  <h2>Highlights</h2>
  <p>Three new warehouse deployments went live in September, and the pilot with our largest logistics customer converted to a three-year contract. Gross margin improved as the second-generation gripper replaced contract manufacturing.</p>
  <h2>Operating summary</h2>
  <table>
    <tr><th>€ thousands</th><th>Q1</th><th>Q2</th><th>Q3</th></tr>
    <tr><td>Revenue</td><td>290</td><td>333</td><td>460</td></tr>
    <tr><td>Gross margin</td><td>41%</td><td>44%</td><td>52%</td></tr>
    <tr><td>Operating expenses</td><td>610</td><td>655</td><td>702</td></tr>
    <tr><td>Net burn</td><td>(491)</td><td>(508)</td><td>(463)</td></tr>
  </table>
  <p>We are raising a €6m Series A to expand into two further markets. The full model, cap table, and customer contracts are in this room.</p>
</main>
<footer><span>Synthetic demonstration document</span><span>Page 1</span></footer>
</body></html>`;

let server: TestServer | undefined;

test.beforeAll(async ({ browser }) => {
  const renderer = await browser.newPage({
    viewport: { width: 1200, height: 1600 },
    deviceScaleFactor: 2,
  });
  await renderer.setContent(SYNTHETIC_PAGE);
  const pageImage = Buffer.from(await renderer.screenshot({ type: 'png' }));
  await renderer.close();
  server = await startTestServer({ pageImage, realWatermark: true });
});

test.afterAll(async () => {
  if (server !== undefined) await server.close();
});

async function useCookies(
  page: Page,
  cookies: readonly { name: string; value: string; url: string }[],
): Promise<void> {
  await page
    .context()
    .addCookies(cookies.map(({ name, value, url }) => ({ name, value, url })));
}

async function openReader(page: Page): Promise<void> {
  if (server === undefined) throw new Error('SCREENSHOT_SERVER_NOT_STARTED');
  const seeded = await server.signInViewer({ roomTitle: ROOM, documentTitle: DOCUMENT });
  await useCookies(page, seeded.cookies);
  await page.goto(server.baseUrl);
  await page
    .getByRole('main')
    .getByRole('button', { name: new RegExp(ROOM, 'u') })
    .click();
  await expect(page.getByRole('row', { name: new RegExp(DOCUMENT, 'u') })).toBeVisible();
  await page
    .getByRole('button', { name: new RegExp(`Read ${DOCUMENT}`, 'u') })
    .first()
    .click();
  const sheet = page.getByRole('img').first();
  await expect(sheet).toBeVisible();
  await page.waitForLoadState('networkidle');
}

async function openRoomSection(
  page: Page,
  section: 'Access' | 'Processing',
  seed: Parameters<TestServer['signInMember']>[0],
): Promise<void> {
  if (server === undefined) throw new Error('SCREENSHOT_SERVER_NOT_STARTED');
  const seeded = await server.signInMember(seed);
  await useCookies(page, seeded.cookies);
  await page.goto(server.baseUrl);
  await page
    .getByRole('button', { name: new RegExp(`Open room ${seed.roomTitle ?? ''}`, 'u') })
    .click();
  await page.getByRole('button', { name: section, exact: true }).click();
  await page.waitForLoadState('networkidle');
}

test('reading room, light', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await openReader(page);
  await page.screenshot({ path: `${OUT}reading-room.png` });
});

test('reading room, dark', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await openReader(page);
  await page.screenshot({ path: `${OUT}reading-room-dark.png` });
});

test('reading room, phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'light' });
  await openReader(page);
  const phone = Buffer.from(await page.screenshot({ type: 'png' }));
  // Centred on a grid-sized canvas (the sunken ground and hairline rule tokens),
  // so the phone view occupies a cell exactly like the desktop images. A blank
  // document first, because the app's CSP would block the canvas's inline styles.
  await page.goto('about:blank');
  await page.setViewportSize(GRID);
  await page.setContent(
    `<body style="margin:0;height:100vh;display:grid;place-items:center;background:#e8eae7"><img alt="" src="data:image/png;base64,${phone.toString('base64')}" style="height:680px;border:1px solid #c7cdc7"></body>`,
  );
  await page.screenshot({ path: `${OUT}reading-room-phone.png` });
});

test('viewer sign-in', async ({ page }) => {
  if (server === undefined) throw new Error('SCREENSHOT_SERVER_NOT_STARTED');
  await page.setViewportSize(GRID);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(`${server.baseUrl}/read`);
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: `${OUT}viewer-sign-in.png` });
});

test('member access', async ({ page }) => {
  await page.setViewportSize(GRID);
  await page.emulateMedia({ colorScheme: 'light' });
  await openRoomSection(page, 'Access', {
    globalRole: 'admin',
    roomTitle: 'Larkspur Series A',
    roomRole: 'manager',
    withParticipant: { email: 'maria.lindqvist@example.com', grant: 'active' },
  });
  await page.screenshot({ path: `${OUT}member-access.png` });
});

test('member processing', async ({ page }) => {
  await page.setViewportSize(GRID);
  await page.emulateMedia({ colorScheme: 'light' });
  await openRoomSection(page, 'Processing', {
    globalRole: 'admin',
    roomTitle: 'Seed extension',
    roomRole: 'manager',
    withProcessing: [
      { title: 'Customer contracts', state: 'quarantine' },
      { title: 'Cap table', state: 'processing_failed' },
      { title: 'Unsolicited attachment', state: 'malware_quarantined' },
    ],
  });
  await page.screenshot({ path: `${OUT}member-processing.png` });
});
