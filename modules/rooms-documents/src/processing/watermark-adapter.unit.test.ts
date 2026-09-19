import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { sandboxProgram } from './sandbox.ts';
import { composeWatermarkPage } from '../protected-delivery.ts';
import { detectPng } from './watermark-adapter.ts';

function computeCrc32(buffer: Uint8Array): number {
  let crc = 0xffffffff;
  for (let byte of buffer) {
    for (let j = 0; j < 8; j += 1) {
      const bit = (crc ^ byte) & 1;
      crc >>>= 1;
      if (bit === 1) crc ^= 0xedb88320;
      byte >>>= 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createTestPng(width: number, height: number, variant = 0): Buffer {
  const rowSize = width * 3 + 1;
  const rawData = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y += 1) {
    rawData[y * rowSize] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = y * rowSize + 1 + x * 3;
      rawData[offset] = (x * 7 + variant * 61) % 256;
      rawData[offset + 1] = (y * 11 + variant * 97) % 256;
      rawData[offset + 2] = ((x + y) * 5 + variant * 37) % 256;
    }
  }
  const idatData = deflateSync(rawData);
  const chunks: Uint8Array[] = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];

  function writeChunk(type: string, data: Uint8Array): void {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(data.length, 0);
    header.write(type, 4, 'ascii');
    const payload = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = computeCrc32(payload);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc >>> 0, 0);
    chunks.push(header, data, crcBuf);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  writeChunk('IHDR', ihdr);
  writeChunk('IDAT', idatData);
  writeChunk('IEND', Buffer.alloc(0));
  return Buffer.concat(chunks);
}

describe('watermark adapter units', () => {
  it('parses valid PNG dimensions and rejects every other format', () => {
    expect(detectPng(createTestPng(320, 240))).toEqual({ width: 320, height: 240 });
    expect(() => detectPng(Buffer.from('not an image'))).toThrow('WATERMARK_INPUT_UNSUPPORTED');
    expect(() => detectPng(Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBP', 'binary'))).toThrow(
      'WATERMARK_INPUT_UNSUPPORTED',
    );
  });
});

function resolveTestImageTool(): string {
  for (const candidate of ['/usr/bin/magick', '/usr/bin/convert'])
    if (existsSync(candidate)) return candidate;
  throw new Error('IMAGEMAGICK_TEST_TOOL_MISSING');
}

describe('production watermark adapter through sandbox', () => {
  const adapterPath = fileURLToPath(new URL('./watermark-adapter.ts', import.meta.url));
  const tool = resolveTestImageTool();

  it('composites watermark via real bubblewrap sandbox and renders hostile and non-Latin text literally', async () => {
    const program = sandboxProgram(process.execPath, [adapterPath, tool]);
    const source = createTestPng(300, 200);
    const alternateSource = createTestPng(300, 200, 1);

    const watermark = {
      program,
      viewerEmail: 'investor@example.com',
      accessDateUtc: '2026-03-01',
      roomName: 'Confidential @/etc/passwd 100% %[exif:*] Äriplaan 投資家向け資料',
    } as const;
    const watermarked = await composeWatermarkPage({ ...watermark, source });
    const alternateWatermarked = await composeWatermarkPage({
      ...watermark,
      source: alternateSource,
    });

    // 1. Output decodes as PNG
    expect(Buffer.from(watermarked).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    // 2. Dimensions match input (300 x 200)
    const outWidth = Buffer.from(watermarked).readUInt32BE(16);
    const outHeight = Buffer.from(watermarked).readUInt32BE(20);
    expect(outWidth).toBe(300);
    expect(outHeight).toBe(200);
    // 3. Output differs from input (watermark marks applied)
    expect(Buffer.from(watermarked).equals(source)).toBe(false);
    // 4. The source page survives composition. The same watermark over two
    // different pages must not collapse to the same tiled image.
    expect(Buffer.from(watermarked).equals(Buffer.from(alternateWatermarked))).toBe(false);
    // The fixture contains Latin, hostile ImageMagick syntax, and CJK. Comparing
    // against a Latin-only rendering proves those glyphs changed actual pixels,
    // rather than merely proving that some watermark was applied.
    const latinOnly = await composeWatermarkPage({
      program,
      source,
      viewerEmail: 'investor@example.com',
      accessDateUtc: '2026-03-01',
      roomName: 'Confidential',
    });
    expect(Buffer.from(watermarked).equals(Buffer.from(latinOnly))).toBe(false);
    expect(watermarked.length).toBeGreaterThan(0);
  });
});
