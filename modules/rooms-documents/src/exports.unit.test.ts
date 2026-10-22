import { describe, expect, it } from 'vitest';
import { type ZipEntry, streamingZip } from './exports.ts';

/*
 * The archive must open exactly one source at a time. Building the entry list by
 * awaiting storage.streamSource for every document opened up to the 1,000-document
 * selection limit of concurrent provider bodies before the first byte was consumed,
 * which exhausts sockets and provider concurrency without buffering anything.
 */
describe('streaming export archive', () => {
  function tracked(count: number): {
    readonly entries: readonly ZipEntry[];
    readonly state: { active: number; peak: number; opened: number };
  } {
    const state = { active: 0, peak: 0, opened: 0 };
    const entries = Array.from({ length: count }, (_, index) => ({
      name: `${String(index).padStart(4, '0')}.bin`,
      open: () => {
        state.opened += 1;
        state.active += 1;
        state.peak = Math.max(state.peak, state.active);
        return {
          async *[Symbol.asyncIterator]() {
            try {
              await Promise.resolve();
              yield new Uint8Array([index % 256]);
            } finally {
              state.active -= 1;
            }
          },
        };
      },
    }));
    return { entries, state };
  }

  it('opens one source at a time rather than every source up front', async () => {
    const { entries, state } = tracked(64);
    const iterator = streamingZip(entries)[Symbol.asyncIterator]();
    await iterator.next();
    expect(state.opened).toBeLessThanOrEqual(1);
    let bytes = 0;
    for (let step = await iterator.next(); step.done !== true; step = await iterator.next())
      bytes += step.value.byteLength;
    expect(bytes).toBeGreaterThan(0);
    expect(state.opened).toBe(64);
    expect(state.peak).toBe(1);
    expect(state.active).toBe(0);
  });

  it('produces a local file header and refuses a path-bearing entry name', async () => {
    const { entries } = tracked(1);
    const first = await streamingZip(entries)[Symbol.asyncIterator]().next();
    expect(Buffer.from(first.value as Uint8Array).readUInt32LE(0)).toBe(0x04034b50);
    const hostile: readonly ZipEntry[] = [
      {
        name: '../escape.bin',
        open: () => ({
          async *[Symbol.asyncIterator]() {
            await Promise.resolve();
            yield new Uint8Array([1]);
          },
        }),
      },
    ];
    await expect(
      (async () => {
        for await (const chunk of streamingZip(hostile)) expect(chunk).toBeDefined();
      })(),
    ).rejects.toThrow('EXPORT_ZIP_NAME_INVALID');
  });

  it('writes the standard CRC-32 of an entry streamed in several chunks', async () => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of streamingZip([
      {
        name: 'check.txt',
        open: () => ({
          async *[Symbol.asyncIterator]() {
            await Promise.resolve();
            yield Buffer.from('1234', 'utf8');
            yield Buffer.from('56789', 'utf8');
          },
        }),
      },
    ]))
      chunks.push(chunk);
    const archive = Buffer.concat(chunks);
    // Local header (30) + name (9) + data (9), then the descriptor signature.
    const descriptor = 30 + 9 + 9;
    expect(archive.readUInt32LE(descriptor)).toBe(0x08074b50);
    expect(archive.readUInt32LE(descriptor + 4)).toBe(0xcbf43926);
  });

  it('refuses to grow past the 32-bit ZIP offset limit before writing an out-of-range field', async () => {
    // A reported length stands in for gigabytes of source bytes.
    function reported(byteLength: number): Uint8Array {
      return Object.defineProperty(new Uint8Array(1), 'byteLength', { value: byteLength });
    }
    const entry = (name: string, byteLength: number): ZipEntry => ({
      name,
      open: () => ({
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          yield reported(byteLength);
        },
      }),
    });
    const drain = async (entries: readonly ZipEntry[]): Promise<void> => {
      for await (const chunk of streamingZip(entries)) expect(chunk).toBeDefined();
    };
    await expect(drain([entry('a.bin', 0xffffff00), entry('b.bin', 0x100)])).rejects.toThrow(
      'EXPORT_ZIP_LIMIT_EXCEEDED',
    );
    // Header (30), name (5) and descriptor (16) count: one byte more cannot fit.
    const largest = 0xffffffff - 30 - 5 - 16;
    await expect(drain([entry('a.bin', largest)])).resolves.toBeUndefined();
    await expect(drain([entry('a.bin', largest + 1)])).rejects.toThrow(
      'EXPORT_ZIP_LIMIT_EXCEEDED',
    );
  });
});
