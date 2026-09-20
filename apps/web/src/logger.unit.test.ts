import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createWebLogger } from './app.ts';
import { createOpaqueId } from '@duefold/shared/ids';

class Capture extends Writable {
  public readonly chunks: string[] = [];
  public override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString());
    callback();
  }
}

describe('real logger allowlisted serialization', () => {
  it('omits every prohibited category even when embedded in an error message', () => {
    const capture = new Capture();
    const logger = createWebLogger(capture);
    const protectedId = createOpaqueId();
    logger.error({
      err: new Error(
        `board.pdf Investor@Example.com 12345678 Bearer token private/object-key ${protectedId} 192.0.2.10 document content`,
      ),
      event: 'Investor@example.com board.pdf private/object-key',
      code: 'Bearer secret-token',
      service: 'private/object-key',
      correlation: protectedId,
      requestBody: 'confidential request',
    });
    const serialized = capture.chunks.join('');
    expect(serialized).toContain('REQUEST_FAILED');
    expect(JSON.parse(serialized)).not.toHaveProperty('correlation');
    for (const forbidden of [
      'board.pdf',
      'Investor@Example.com',
      '12345678',
      'Bearer token',
      'private/object-key',
      protectedId,
      '192.0.2.10',
      'document content',
      'confidential request',
    ])
      expect(serialized).not.toContain(forbidden);
  });

  it('keeps an allowlisted refusal code so a failure is diagnosable', () => {
    /*
     * A member sign-in failure used to serialize as a bare REQUEST_FAILED with no
     * audit row, so the failure screen told the operator to ask an administrator to
     * check access while giving that administrator nothing to check. The reason has
     * to survive redaction, and only as one of the server's own closed-set codes.
     */
    const capture = new Capture();
    const logger = createWebLogger(capture);
    logger.warn({
      err: new Error('OIDC_AUTH_TIME_REQUIRED'),
      event: 'auth.oidc.refused',
      code: 'OIDC_AUTH_TIME_REQUIRED',
    });
    const serialized = capture.chunks.join('');
    expect(JSON.parse(serialized)).toMatchObject({
      event: 'auth.oidc.refused',
      code: 'OIDC_AUTH_TIME_REQUIRED',
    });
    // The error itself is still never serialized, only the code.
    expect(serialized).not.toContain('Error');
    expect(serialized).not.toContain('stack');
  });

  it('still drops a code outside the closed set', () => {
    const capture = new Capture();
    const logger = createWebLogger(capture);
    logger.warn({
      err: new Error('boom'),
      event: 'auth.oidc.refused',
      // Attacker-influenced or simply unknown: must not reach the log, and must
      // not be able to smuggle text through a known key.
      code: 'georg@juhus.ee refused because sub=1234567890',
    });
    const parsed = JSON.parse(capture.chunks.join('')) as { code?: unknown };
    // Falls back to the fixed marker rather than echoing the supplied value.
    expect(parsed.code).toBe('REQUEST_FAILED');
    expect(capture.chunks.join('')).not.toContain('juhus.ee');
    expect(capture.chunks.join('')).not.toContain('1234567890');
  });
});
