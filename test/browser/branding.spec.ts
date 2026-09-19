import { expect, test } from '@playwright/test';
import { startTestServer, type TestServer } from '../support/browser-server.ts';

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  await server.close();
});

test('shows attribution only with a custom logo and loads public branding once', async ({
  page,
}) => {
  let brandingRequests = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/branding/public') brandingRequests += 1;
  });

  // Installation identity and edited text are not evidence of a custom logo.
  await server.migrationPool.query(
    "UPDATE organization SET name='Acme Capital'; UPDATE branding_configuration SET revision=1",
  );
  await page.goto(server.baseUrl);
  await expect(page.getByText('Acme Capital')).toBeVisible();
  await expect(page.getByText('Powered by Duefold')).toHaveCount(0);
  await expect.poll(() => brandingRequests).toBe(1);

  // A processed logo is the single attribution signal.
  const objectKey = `branding/${'a'.repeat(32)}/${'b'.repeat(32)}.png`;
  await server.migrationPool.query("UPDATE organization SET name='Duefold'");
  await server.migrationPool.query(
    `INSERT INTO branding_asset(asset_kind,object_key,media_type,size_bytes,width,height)
     VALUES('logo',$1,'image/png',4,100,100)
     ON CONFLICT(asset_kind) DO UPDATE SET object_key=EXCLUDED.object_key`,
    [objectKey],
  );
  brandingRequests = 0;
  await page.reload();
  await expect(page.getByRole('img', { name: 'Duefold' })).toBeVisible();
  await expect(page.getByText('Powered by Duefold')).toBeVisible();
  await expect.poll(() => brandingRequests).toBe(1);
});
