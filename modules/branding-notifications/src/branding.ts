import type { ClamAvClient } from '../../rooms-documents/src/scanning/clamav.ts';
import { parseProcessorOutput } from '../../rooms-documents/src/processing/formats.ts';
import type { SandboxIsolation } from '../../rooms-documents/src/processing/preflight.ts';
import {
  invokeSandboxed,
  type SandboxProgram,
} from '../../rooms-documents/src/processing/sandbox.ts';
import {
  MAX_IMAGE_AXIS,
  MAX_IMAGE_DECODED_BYTES,
  MAX_IMAGE_PIXELS,
  MAX_SOURCE_BYTES,
} from '../../rooms-documents/src/resource-policy.ts';

export const BRAND_IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type BrandImageMediaType = (typeof BRAND_IMAGE_MEDIA_TYPES)[number];
const LIGHT_GROUND = '#f2f3f1';
const DARK_GROUND = '#161a18';
const MINIMUM_ACCENT_CONTRAST = 3;

function srgb(value: number): number {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}
function luminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/iu.exec(hex);
  if (match?.[1] === undefined) throw new Error('BRAND_ACCENT_INVALID');
  const raw = match[1];
  const values = [raw.slice(0, 2), raw.slice(2, 4), raw.slice(4, 6)].map((value) =>
    Number.parseInt(value, 16),
  );
  const [r = 0, g = 0, b = 0] = values.map(srgb);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrastRatio(first: string, second: string): number {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return ((values[0] ?? 0) + 0.05) / ((values[1] ?? 0) + 0.05);
}
export function validateAccentColor(value: string): string {
  if (!/^#[0-9a-f]{6}$/iu.test(value)) throw new Error('BRAND_ACCENT_INVALID');
  const normalized = value.toLowerCase();
  const light = contrastRatio(normalized, LIGHT_GROUND);
  const dark = contrastRatio(normalized, DARK_GROUND);
  if (light < MINIMUM_ACCENT_CONTRAST || dark < MINIMUM_ACCENT_CONTRAST)
    throw new Error(
      `BRAND_ACCENT_CONTRAST_FAILED light=${light.toFixed(2)} dark=${dark.toFixed(2)} required=${MINIMUM_ACCENT_CONTRAST.toFixed(2)}`,
    );
  return normalized;
}

function starts(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}
function pngEnd(bytes: Uint8Array): number {
  if (!starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    throw new Error('BRAND_IMAGE_CONTENT_REJECTED');
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = Buffer.from(bytes).readUInt32BE(offset);
    const type = Buffer.from(bytes.subarray(offset + 4, offset + 8)).toString('ascii');
    offset += 12 + length;
    if (offset > bytes.length) throw new Error('BRAND_IMAGE_CONTENT_REJECTED');
    if (type === 'IEND') return offset;
  }
  throw new Error('BRAND_IMAGE_CONTENT_REJECTED');
}
function jpegEnd(bytes: Uint8Array): number {
  if (!starts(bytes, [0xff, 0xd8])) throw new Error('BRAND_IMAGE_CONTENT_REJECTED');
  for (let offset = bytes.length - 2; offset >= 2; offset -= 1)
    if (bytes[offset] === 0xff && bytes[offset + 1] === 0xd9) return offset + 2;
  throw new Error('BRAND_IMAGE_CONTENT_REJECTED');
}
function webpEnd(bytes: Uint8Array): number {
  if (
    !starts(bytes, [0x52, 0x49, 0x46, 0x46]) ||
    Buffer.from(bytes.subarray(8, 12)).toString('ascii') !== 'WEBP' ||
    bytes.length < 12
  )
    throw new Error('BRAND_IMAGE_CONTENT_REJECTED');
  return Buffer.from(bytes).readUInt32LE(4) + 8;
}
function inspectContainer(bytes: Uint8Array, mediaType: BrandImageMediaType): void {
  if (bytes.length < 12 || bytes.length > MAX_SOURCE_BYTES)
    throw new Error('BRAND_IMAGE_CONTENT_REJECTED');
  const end =
    mediaType === 'image/png'
      ? pngEnd(bytes)
      : mediaType === 'image/jpeg'
        ? jpegEnd(bytes)
        : webpEnd(bytes);
  // Exact container length rejects appended SVG/HTML/JS and image polyglots.
  if (end !== bytes.length) throw new Error('BRAND_IMAGE_CONTENT_REJECTED');
}
export function inspectBrandImage(bytes: Uint8Array, mediaType: string): BrandImageMediaType {
  if (!BRAND_IMAGE_MEDIA_TYPES.includes(mediaType as BrandImageMediaType))
    throw new Error('BRAND_IMAGE_TYPE_REJECTED');
  const typed = mediaType as BrandImageMediaType;
  inspectContainer(bytes, typed);
  return typed;
}
export interface ProcessedBrandImage {
  readonly mediaType: 'image/png';
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}
export async function processBrandImage(input: {
  readonly bytes: Uint8Array;
  readonly declaredMediaType: string;
  readonly scanner: ClamAvClient;
  readonly program: SandboxProgram;
  readonly isolation?: SandboxIsolation;
  readonly invoke?: typeof invokeSandboxed;
}): Promise<ProcessedBrandImage> {
  const mediaType = inspectBrandImage(input.bytes, input.declaredMediaType);
  const scan = await input.scanner.scan(input.bytes);
  if (scan.result !== 'clean') throw new Error('BRAND_IMAGE_SCAN_REJECTED');
  const output = await (input.invoke ?? invokeSandboxed)({
    program: input.program,
    arguments: [mediaType],
    input: input.bytes,
    limits: {
      timeoutMilliseconds: 30_000,
      maximumInputBytes: MAX_SOURCE_BYTES,
      maximumOutputBytes: MAX_IMAGE_DECODED_BYTES,
      maximumTemporaryBytes: MAX_IMAGE_DECODED_BYTES,
    },
    ...(input.isolation === undefined || input.isolation.mode === 'namespaced'
      ? {}
      : { mode: input.isolation.mode, identities: input.isolation.identities }),
  });
  const processed = parseProcessorOutput(output);
  if (processed.pages.length !== 1) throw new Error('BRAND_IMAGE_PROCESSOR_REJECTED');
  const page = processed.pages[0];
  if (page?.mediaType !== 'image/png') throw new Error('BRAND_IMAGE_PROCESSOR_REJECTED');
  const { image, width, height } = page;
  // The credential-free adapter must emit exactly one freshly encoded PNG.
  if (pngEnd(image) !== image.length || image.length < 24)
    throw new Error('BRAND_IMAGE_PROCESSOR_REJECTED');
  if (
    width < 1 ||
    height < 1 ||
    width > MAX_IMAGE_AXIS ||
    height > MAX_IMAGE_AXIS ||
    width * height > MAX_IMAGE_PIXELS ||
    width * height * 4 > MAX_IMAGE_DECODED_BYTES
  )
    throw new Error('BRAND_IMAGE_RESOURCE_REJECTED');
  return { mediaType: 'image/png', bytes: image, width, height };
}

function optionalPlainText(
  value: string | undefined,
  maximum: number,
  code: string,
  allowEmpty = false,
): string | undefined {
  if (value === undefined) return undefined;
  if ((!allowEmpty && value === '') || value.length > maximum * 2 || /[<>\0]/u.test(value))
    throw new Error(code);
  return value.normalize('NFC');
}
export function validateBranding(input: {
  readonly organizationName?: string;
  readonly accentColor?: string;
  readonly senderDisplayName?: string;
  readonly roomIntroduction?: string;
  readonly supportContact?: string;
}): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  const organization = optionalPlainText(
    input.organizationName,
    200,
    'BRAND_ORGANIZATION_INVALID',
  );
  const sender = optionalPlainText(input.senderDisplayName, 200, 'BRAND_SENDER_INVALID');
  const introduction = optionalPlainText(
    input.roomIntroduction,
    2_000,
    'BRAND_INTRODUCTION_INVALID',
    true,
  );
  if (organization !== undefined) result['organizationName'] = organization;
  if (sender !== undefined) result['senderDisplayName'] = sender;
  if (introduction !== undefined) result['roomIntroduction'] = introduction;
  if (input.accentColor !== undefined)
    result['accentColor'] = validateAccentColor(input.accentColor);
  if (input.supportContact !== undefined) {
    const contact = input.supportContact;
    const email = /^[^\s@<>]+@[^\s@<>]+$/u.test(contact);
    let https: boolean;
    try {
      const url = new URL(contact);
      https = url.protocol === 'https:' && url.username === '' && url.password === '';
    } catch {
      https = false;
    }
    if (!email && !https) throw new Error('BRAND_SUPPORT_INVALID');
    result['supportContact'] = contact;
  }
  return result;
}
