import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);

/* Every dependency points at a closed port, so a refusal made after any network call
   would surface as a later stage instead. */
const webEnvironment = {
  PATH: process.env['PATH'],
  HOME: process.env['HOME'],
  DUEFOLD_DATABASE_URL: 'postgresql://duefold_runtime:unused@127.0.0.1:1/duefold',
  DUEFOLD_AUTH_DATABASE_URL: 'postgresql://duefold_authenticator:unused@127.0.0.1:1/duefold',
  DUEFOLD_PUBLIC_URL: 'https://duefold.example',
  DUEFOLD_OIDC_ISSUER: 'http://127.0.0.1:1',
  DUEFOLD_OIDC_CLIENT_ID: 'client',
  DUEFOLD_OIDC_CLIENT_SECRET: 'secret',
  DUEFOLD_OWNER_EMAIL_ALLOWLIST: 'owner@example.com',
  DUEFOLD_ORGANIZATION_NAME: 'Duefold Test',
  DUEFOLD_OTP_DIGEST_KEY: Buffer.alloc(32, 1).toString('base64url'),
  DUEFOLD_NETWORK_HMAC_KEY: Buffer.alloc(32, 2).toString('base64url'),
  DUEFOLD_SMTP_URL: 'smtp://127.0.0.1:1',
  DUEFOLD_AUTH_MAIL_FROM: 'no-reply@example.com',
  DUEFOLD_STORAGE_ENDPOINT: 'http://127.0.0.1:1',
  DUEFOLD_STORAGE_REGION: 'us-east-1',
  DUEFOLD_STORAGE_BUCKET: 'duefold',
  DUEFOLD_STORAGE_WEB_ACCESS_KEY_ID: 'web-access',
  DUEFOLD_STORAGE_WEB_SECRET_ACCESS_KEY: 'web-secret',
  DUEFOLD_CLAMAV_HOST: '127.0.0.1',
  DUEFOLD_CLAMAV_PORT: '1',
  DUEFOLD_WATERMARK_IMAGE_PROGRAM: '/usr/bin/magick',
};

describe('web startup without a stated client-address source', () => {
  it.each([
    [{}, 'DUEFOLD_CLIENT_ADDRESS_SOURCE_REQUIRED'],
    [{ DUEFOLD_TRUSTED_PROXIES: ',' }, 'DUEFOLD_TRUSTED_PROXIES_EMPTY'],
    [
      { DUEFOLD_TRUSTED_PROXIES: 'false', DUEFOLD_TRUSTED_EDGE_HOPS: '1' },
      'DUEFOLD_TRUSTED_EDGE_HOPS_WITH_TRUSTED_PROXIES',
    ],
  ])('refuses %o in the config stage and names the refusal', async (setting, code) => {
    await expect(
      execute('node', ['apps/web/src/main.ts'], {
        cwd: process.cwd(),
        env: { ...webEnvironment, ...setting },
        timeout: 10_000,
        killSignal: 'SIGKILL',
      }),
    ).rejects.toMatchObject({
      code: 1,
      stdout: '',
      stderr: `${JSON.stringify({
        event: 'process.failure',
        level: 'error',
        code,
        service: 'web',
        stage: 'config',
      })}\n`,
    });
  });
});
