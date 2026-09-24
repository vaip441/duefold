import { expect, test } from '@playwright/test';
import { startTestServer, type TestServer } from '../support/browser-server.ts';

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  await server.close();
});

test('lets the organization identity replace Duefold, with attribution, loading branding once', async ({
  page,
}) => {
  let brandingRequests = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/branding/public') brandingRequests += 1;
  });

  // The Duefold identity: its mark, and no attribution line to itself.
  await server.migrationPool.query(
    "UPDATE organization SET name='Duefold'; UPDATE branding_configuration SET revision=1",
  );
  await page.goto(server.baseUrl);
  await expect(page.locator('.df-brand-identity__mark')).toBeVisible();
  await expect(page.getByText('Powered by Duefold')).toHaveCount(0);
  await expect.poll(() => brandingRequests).toBe(1);

  // An organization name replaces the identity outright; the Duefold mark beside it
  // read as the organization's own logo.
  await server.migrationPool.query("UPDATE organization SET name='Acme Capital'");
  brandingRequests = 0;
  await page.reload();
  await expect(page.getByText('Acme Capital')).toBeVisible();
  await expect(page.locator('.df-brand-identity__mark')).toHaveCount(0);
  await expect(page.getByText('Powered by Duefold')).toBeVisible();
  await expect.poll(() => brandingRequests).toBe(1);

  // A processed logo is a mark: the name stays beside it, and the image is decorative.
  const objectKey = `branding/${'a'.repeat(32)}/${'b'.repeat(32)}.png`;
  await server.migrationPool.query(
    `INSERT INTO branding_asset(asset_kind,object_key,media_type,size_bytes,width,height)
     VALUES('logo',$1,'image/png',4,100,100)
     ON CONFLICT(asset_kind) DO UPDATE SET object_key=EXCLUDED.object_key`,
    [objectKey],
  );
  brandingRequests = 0;
  await page.reload();
  const identity = page.locator('.df-sheet__header .df-brand-identity');
  await expect(identity.locator('.df-brand-identity__custom-logo')).toHaveAttribute('alt', '');
  await expect(identity).toHaveText('Acme Capital');
  await expect(page.getByText('Powered by Duefold')).toBeVisible();
  await expect.poll(() => brandingRequests).toBe(1);

  // A logo an administrator marks as including the name stands for the name alone.
  await server.migrationPool.query('UPDATE branding_configuration SET logo_includes_name=true');
  await page.reload();
  await expect(identity.getByRole('img', { name: 'Acme Capital' })).toBeAttached();
  await expect(identity.locator('.df-facts__wordmark')).toHaveCount(0);
  await server.migrationPool.query(
    "UPDATE branding_configuration SET logo_includes_name=false; DELETE FROM branding_asset WHERE asset_kind='logo'",
  );
});
