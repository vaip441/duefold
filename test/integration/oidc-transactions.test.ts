/**
 * OIDC transactions: consumed strictly once, and abandoned ones purged by the next begin.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  beginOidc,
  consumeOidcTransaction,
  persistOidcTransaction,
} from '../../modules/core-security/src/auth/oidc.ts';
import { authPool, closePools, resetSchema } from '../authz/support/database.ts';

beforeAll(resetSchema);
afterAll(closePools);

describe('OIDC transactions', () => {
  it('persists OIDC state and consumes it strictly once', async () => {
    const configuration = new (await import('openid-client')).Configuration(
      {
        issuer: 'https://issuer.example',
        authorization_endpoint: 'https://issuer.example/auth',
      },
      'client',
    );
    const transaction = await beginOidc(configuration, 'https://duefold.example/callback');
    await persistOidcTransaction(authPool, transaction, 'a'.repeat(64));
    expect(
      await consumeOidcTransaction(authPool, transaction.state, transaction.browserBinding),
    ).toMatchObject({
      state: transaction.state,
      nonce: transaction.nonce,
      codeVerifier: transaction.codeVerifier,
    });
    await expect(
      consumeOidcTransaction(authPool, transaction.state, transaction.browserBinding),
    ).rejects.toThrow('OIDC_TRANSACTION_INVALID');
  });

  it('purges abandoned OIDC transactions when a new one begins', async () => {
    const configuration = new (await import('openid-client')).Configuration(
      {
        issuer: 'https://issuer.example',
        authorization_endpoint: 'https://issuer.example/auth',
      },
      'client',
    );
    const abandoned = await beginOidc(configuration, 'https://duefold.example/callback');
    const live = await beginOidc(configuration, 'https://duefold.example/callback');
    await persistOidcTransaction(
      authPool,
      abandoned,
      'a'.repeat(64),
      new Date(Date.now() - 3_600_000),
    );
    await persistOidcTransaction(authPool, live, 'a'.repeat(64));
    const remaining = await authPool.query<{ expired: string }>(
      'SELECT count(*)::text AS expired FROM oidc_transaction WHERE expires_at <= now()',
    );
    expect(remaining.rows[0]?.expired).toBe('0');
    await expect(
      consumeOidcTransaction(authPool, live.state, live.browserBinding),
    ).resolves.toMatchObject({ state: live.state });
  });
});
