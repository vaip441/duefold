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
});
