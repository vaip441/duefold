import { describe, expect, it, vi } from 'vitest';
import { sandboxProgram } from '../../rooms-documents/src/processing/sandbox.ts';
import {
  inspectBrandImage,
  processBrandImage,
  validateAccentColor,
  validateBranding,
} from './branding.ts';

function png(extra = new Uint8Array()): Uint8Array {
  const bytes = Buffer.alloc(45 + extra.length);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(1, 16);
  bytes.writeUInt32BE(1, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  // CRC is intentionally not parsed here; decoder in the sandbox is the
  // authoritative structural parser. Container framing prevents polyglots.
  bytes.writeUInt32BE(0, 33);
  bytes.write('IEND', 37, 'ascii');
  extra.forEach((value, index) => {
    bytes[45 + index] = value;
  });
  return bytes;
}

function processorOutput(image: Uint8Array = png()): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      pages: [
        {
          mediaType: 'image/png',
          imageBase64: Buffer.from(image).toString('base64'),
          width: 1,
          height: 1,
          accessibleLabel: 'Page 1',
          textLayer: null,
        },
      ],
      hiddenSheets: [],
    }),
  );
}

describe('constrained branding', () => {
  it('accepts a contrast-valid accent and reports both measured ratios when one fails', () => {
    expect(validateAccentColor('#08766a')).toBe('#08766a');
    expect(() => validateAccentColor('#f2f3f1')).toThrow(
      /BRAND_ACCENT_CONTRAST_FAILED light=1\.00 dark=\d+\.\d{2} required=3\.00/u,
    );
  });

  it('permits only the specified plain-text branding fields', () => {
    expect(
      validateBranding({
        organizationName: 'North Star',
        accentColor: '#08766a',
        senderDisplayName: 'North Star Data Room',
        roomIntroduction: 'Prepared materials.',
        supportContact: 'https://support.example/help',
      }),
    ).toEqual({
      organizationName: 'North Star',
      accentColor: '#08766a',
      senderDisplayName: 'North Star Data Room',
      roomIntroduction: 'Prepared materials.',
      supportContact: 'https://support.example/help',
    });
    expect(() => validateBranding({ roomIntroduction: '<script>alert(1)</script>' })).toThrow(
      'BRAND_INTRODUCTION_INVALID',
    );
  });

  it('rejects SVG, renamed HTML/JS, and image polyglots by content rather than extension', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const renamed = Buffer.from('<script>globalThis.pwned=true</script>');
    const polyglot = png(Buffer.from('<script>alert(1)</script>'));
    expect(() => inspectBrandImage(svg, 'image/svg+xml')).toThrow('BRAND_IMAGE_TYPE_REJECTED');
    expect(() => inspectBrandImage(renamed, 'image/png')).toThrow(
      'BRAND_IMAGE_CONTENT_REJECTED',
    );
    expect(() => inspectBrandImage(polyglot, 'image/png')).toThrow(
      'BRAND_IMAGE_CONTENT_REJECTED',
    );
    expect(inspectBrandImage(png(), 'image/png')).toBe('image/png');
  });

  it('scans before using the shared credential-free sandbox and returns only a fresh bounded PNG', async () => {
    const order: string[] = [];
    const scanner = {
      readSignatures: () =>
        Promise.resolve({ signatureVersion: 'test', signatureDate: new Date() }),
      checkReady: () =>
        Promise.resolve({ signatureVersion: 'test', signatureDate: new Date() }),
      scan: vi.fn(() => {
        order.push('scan');
        return Promise.resolve({
          result: 'clean' as const,
          signatureVersion: 'test',
          signatureDate: new Date(),
        });
      }),
    };
    const invoke = vi.fn(() => {
      order.push('sandbox');
      return Promise.resolve(processorOutput());
    });
    const result = await processBrandImage({
      bytes: png(),
      declaredMediaType: 'image/png',
      scanner,
      program: sandboxProgram('/fixture/branding-image'),
      invoke,
    });
    expect(order).toEqual(['scan', 'sandbox']);
    expect(result).toMatchObject({ mediaType: 'image/png', width: 1, height: 1 });
    await expect(
      processBrandImage({
        bytes: png(),
        declaredMediaType: 'image/png',
        scanner,
        program: sandboxProgram('/fixture/branding-image'),
        invoke: () => Promise.resolve(png()),
      }),
    ).rejects.toThrow('PROCESSOR_RESPONSE_INVALID');
    const invocation = invoke.mock.calls[0] as unknown as readonly [
      { readonly limits: Readonly<Record<string, number>> },
    ];
    expect(invocation[0]).toMatchObject({
      limits: {
        maximumInputBytes: 262_144_000,
        maximumOutputBytes: 268_435_456,
        maximumTemporaryBytes: 268_435_456,
      },
    });
  });
});
