import { describe, expect, it } from 'vitest';
import { multipartParts } from './s3-compatible.ts';

async function parts(chunkSizes: readonly number[], partBytes: number): Promise<Buffer[]> {
  let next = 0;
  async function* source(): AsyncGenerator<Uint8Array> {
    for (const size of chunkSizes) {
      await Promise.resolve();
      yield Uint8Array.from({ length: size }, () => next++ % 256);
    }
  }
  const collected: Buffer[] = [];
  for await (const part of multipartParts(source(), partBytes)) collected.push(part);
  return collected;
}
function sequence(length: number): Buffer {
  return Buffer.from(Uint8Array.from({ length }, (_, index) => index % 256));
}

describe('multipart export parts', () => {
  it('emits only full parts when the stream is an exact multiple of the part size', async () => {
    const collected = await parts([3, 0, 5, 2, 6], 4);
    expect(collected.map((part) => part.byteLength)).toEqual([4, 4, 4, 4]);
    expect(Buffer.concat(collected)).toEqual(sequence(16));
  });

  it('splits a chunk spanning several parts and emits the remainder last', async () => {
    const collected = await parts([1, 9, 3], 4);
    expect(collected.map((part) => part.byteLength)).toEqual([4, 4, 4, 1]);
    expect(Buffer.concat(collected)).toEqual(sequence(13));
  });

  it('emits nothing for an empty stream', async () => {
    expect(await parts([0, 0], 4)).toEqual([]);
  });
});
