import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { inflateRawSync } from 'node:zlib';
import {
  MAX_IMAGE_AXIS,
  MAX_IMAGE_DECODED_BYTES,
  MAX_IMAGE_PIXELS,
  MAX_OFFICE_COMPRESSION_RATIO,
  MAX_OFFICE_UNCOMPRESSED_BYTES,
  MAX_SOURCE_BYTES,
} from './resource-policy.ts';

export const SOURCE_MEDIA_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.spreadsheet',
] as const;
export type SourceMediaType = (typeof SOURCE_MEDIA_TYPES)[number];
export interface ValidatedSource {
  readonly mediaType: SourceMediaType;
  readonly size: number;
  readonly sha256: string;
}
export interface ValidatedOfficeEntry {
  readonly name: string;
  readonly content: Uint8Array;
}
interface ZipEntry {
  readonly name: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly flags: number;
  content?: Uint8Array;
}
const BYTE_MISSING = 'SOURCE_TRUNCATED';
const ZIP_LOCAL_HEADER = [0x50, 0x4b, 0x03, 0x04] as const;
const ZIP_CENTRAL_HEADER = [0x50, 0x4b, 0x01, 0x02] as const;
const ZIP_END_OF_CENTRAL_DIRECTORY = [0x50, 0x4b, 0x05, 0x06] as const;
const MAX_ZIP_ENTRIES = 10_000;
const CRC32_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1)
    crc = (crc & 1) === 0 ? crc >>> 1 : 0xedb88320 ^ (crc >>> 1);
  return crc >>> 0;
});
function byte(bytes: Uint8Array, offset: number): number {
  const value = bytes[offset];
  if (value === undefined) throw new Error(BYTE_MISSING);
  return value;
}
function unsigned16(bytes: Uint8Array, offset: number): number {
  return byte(bytes, offset) | (byte(bytes, offset + 1) << 8);
}
function unsigned32(bytes: Uint8Array, offset: number): number {
  return (
    (byte(bytes, offset) |
      (byte(bytes, offset + 1) << 8) |
      (byte(bytes, offset + 2) << 16) |
      (byte(bytes, offset + 3) << 24)) >>>
    0
  );
}
function has(bytes: Uint8Array, offset: number, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[offset + index] === value);
}
function decodeAscii(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8');
}
function decodeZipName(bytes: Uint8Array): string {
  let name: string;
  try {
    name = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('SOURCE_CONTAINER_REJECTED');
  }
  if (
    name === '' ||
    name.includes('\0') ||
    name.startsWith('/') ||
    name.startsWith('\\') ||
    name.split(/[\\/]/u).some((segment) => segment === '..')
  )
    throw new Error('SOURCE_CONTAINER_REJECTED');
  return name;
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of bytes) crc = (CRC32_TABLE[(crc ^ value) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function endOfCentralDirectory(bytes: Uint8Array): number {
  const firstPossible = Math.max(0, bytes.length - 22 - 65_535);
  for (let offset = bytes.length - 22; offset >= firstPossible; offset -= 1) {
    if (!has(bytes, offset, ZIP_END_OF_CENTRAL_DIRECTORY)) continue;
    const commentLength = unsigned16(bytes, offset + 20);
    if (offset + 22 + commentLength === bytes.length) return offset;
  }
  throw new Error('SOURCE_CONTAINER_REJECTED');
}
function zipEntries(bytes: Uint8Array, retainContent = false): readonly ZipEntry[] {
  const endOffset = endOfCentralDirectory(bytes);
  const disk = unsigned16(bytes, endOffset + 4);
  const centralDisk = unsigned16(bytes, endOffset + 6);
  const diskEntries = unsigned16(bytes, endOffset + 8);
  const entryCount = unsigned16(bytes, endOffset + 10);
  const centralSize = unsigned32(bytes, endOffset + 12);
  const centralOffset = unsigned32(bytes, endOffset + 16);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== entryCount ||
    entryCount < 1 ||
    entryCount > MAX_ZIP_ENTRIES ||
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    centralOffset + centralSize !== endOffset
  )
    throw new Error('SOURCE_CONTAINER_REJECTED');

  const centralEntries: (ZipEntry & {
    readonly method: number;
    readonly crc: number;
    readonly localOffset: number;
  })[] = [];
  const names = new Set<string>();
  let centralCursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (!has(bytes, centralCursor, ZIP_CENTRAL_HEADER))
      throw new Error('SOURCE_CONTAINER_REJECTED');
    const flags = unsigned16(bytes, centralCursor + 8);
    const method = unsigned16(bytes, centralCursor + 10);
    const crc = unsigned32(bytes, centralCursor + 16);
    const compressedSize = unsigned32(bytes, centralCursor + 20);
    const uncompressedSize = unsigned32(bytes, centralCursor + 24);
    const nameLength = unsigned16(bytes, centralCursor + 28);
    const extraLength = unsigned16(bytes, centralCursor + 30);
    const commentLength = unsigned16(bytes, centralCursor + 32);
    const localOffset = unsigned32(bytes, centralCursor + 42);
    const entryEnd = centralCursor + 46 + nameLength + extraLength + commentLength;
    if (
      entryEnd > endOffset ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    )
      throw new Error('SOURCE_CONTAINER_REJECTED');
    if ((flags & 1) !== 0 || (flags & 0x40) !== 0) throw new Error('SOURCE_ENCRYPTED_REJECTED');
    if ((flags & ~0x080e) !== 0 || (method !== 0 && method !== 8))
      throw new Error('SOURCE_CONTAINER_REJECTED');
    const name = decodeZipName(
      bytes.subarray(centralCursor + 46, centralCursor + 46 + nameLength),
    );
    if (names.has(name)) throw new Error('SOURCE_CONTAINER_REJECTED');
    names.add(name);
    centralEntries.push({
      name,
      compressedSize,
      uncompressedSize,
      flags,
      method,
      crc,
      localOffset,
    });
    centralCursor = entryEnd;
  }
  if (centralCursor !== endOffset) throw new Error('SOURCE_CONTAINER_REJECTED');

  const ordered = [...centralEntries].sort(
    (left, right) => left.localOffset - right.localOffset,
  );
  if (ordered[0]?.localOffset !== 0) throw new Error('SOURCE_CONTAINER_REJECTED');
  let expanded = 0;
  let compressed = 0;
  for (const [index, entry] of ordered.entries()) {
    const offset = entry.localOffset;
    if (!has(bytes, offset, ZIP_LOCAL_HEADER)) throw new Error('SOURCE_CONTAINER_REJECTED');
    const localFlags = unsigned16(bytes, offset + 6);
    const localMethod = unsigned16(bytes, offset + 8);
    const localCrc = unsigned32(bytes, offset + 14);
    const localCompressedSize = unsigned32(bytes, offset + 18);
    const localUncompressedSize = unsigned32(bytes, offset + 22);
    const nameLength = unsigned16(bytes, offset + 26);
    const extraLength = unsigned16(bytes, offset + 28);
    const dataOffset = offset + 30 + nameLength + extraLength;
    const dataEnd = dataOffset + entry.compressedSize;
    if (dataEnd > centralOffset) throw new Error('SOURCE_CONTAINER_REJECTED');
    const localName = decodeZipName(bytes.subarray(offset + 30, offset + 30 + nameLength));
    if (localName !== entry.name || localFlags !== entry.flags || localMethod !== entry.method)
      throw new Error('SOURCE_CONTAINER_REJECTED');
    const usesDescriptor = (entry.flags & 8) !== 0;
    if (
      !usesDescriptor &&
      (localCrc !== entry.crc ||
        localCompressedSize !== entry.compressedSize ||
        localUncompressedSize !== entry.uncompressedSize)
    )
      throw new Error('SOURCE_CONTAINER_REJECTED');
    if (
      usesDescriptor &&
      ((localCrc !== 0 && localCrc !== entry.crc) ||
        (localCompressedSize !== 0 && localCompressedSize !== entry.compressedSize) ||
        (localUncompressedSize !== 0 && localUncompressedSize !== entry.uncompressedSize))
    )
      throw new Error('SOURCE_CONTAINER_REJECTED');

    const compressedBytes = bytes.subarray(dataOffset, dataEnd);
    let content: Uint8Array;
    if (entry.method === 0) content = compressedBytes;
    else {
      try {
        content = inflateRawSync(compressedBytes, {
          maxOutputLength: Math.min(
            entry.uncompressedSize + 1,
            MAX_OFFICE_UNCOMPRESSED_BYTES - expanded + 1,
          ),
        });
      } catch {
        throw new Error('SOURCE_CONTAINER_REJECTED');
      }
    }
    if (content.length !== entry.uncompressedSize || crc32(content) !== entry.crc)
      throw new Error('SOURCE_CONTAINER_REJECTED');
    if (retainContent) entry.content = content;
    expanded += content.length;
    compressed += compressedBytes.length;
    if (expanded > MAX_OFFICE_UNCOMPRESSED_BYTES) throw new Error('SOURCE_RESOURCE_REJECTED');

    let entryEnd = dataEnd;
    if (usesDescriptor) {
      const signature = has(bytes, entryEnd, [0x50, 0x4b, 0x07, 0x08]);
      if (signature) entryEnd += 4;
      if (
        unsigned32(bytes, entryEnd) !== entry.crc ||
        unsigned32(bytes, entryEnd + 4) !== entry.compressedSize ||
        unsigned32(bytes, entryEnd + 8) !== entry.uncompressedSize
      )
        throw new Error('SOURCE_CONTAINER_REJECTED');
      entryEnd += 12;
    }
    const nextOffset = ordered[index + 1]?.localOffset ?? centralOffset;
    if (entryEnd !== nextOffset) throw new Error('SOURCE_CONTAINER_REJECTED');
  }
  if (compressed === 0 ? expanded !== 0 : expanded / compressed > MAX_OFFICE_COMPRESSION_RATIO)
    throw new Error('SOURCE_RESOURCE_REJECTED');
  return centralEntries;
}
function imageBounds(width: number, height: number, bytesPerPixel: number): void {
  if (width < 1 || height < 1) throw new Error('SOURCE_IMAGE_REJECTED');
  const pixels = width * height;
  const decoded = pixels * bytesPerPixel;
  if (pixels > MAX_IMAGE_PIXELS || decoded > MAX_IMAGE_DECODED_BYTES)
    throw new Error('SOURCE_RESOURCE_REJECTED');
  if (width > MAX_IMAGE_AXIS || height > MAX_IMAGE_AXIS)
    throw new Error('SOURCE_RESOURCE_REJECTED');
}
function png(bytes: Uint8Array): boolean {
  if (!has(bytes, 0, [137, 80, 78, 71, 13, 10, 26, 10])) return false;
  if (bytes.length < 33 || decodeAscii(bytes.subarray(12, 16)) !== 'IHDR')
    throw new Error('SOURCE_IMAGE_REJECTED');
  const width = Buffer.from(bytes).readUInt32BE(16);
  const height = Buffer.from(bytes).readUInt32BE(20);
  const colorType = bytes[25];
  const channels =
    colorType === 0
      ? 1
      : colorType === 2
        ? 3
        : colorType === 3
          ? 1
          : colorType === 4
            ? 2
            : colorType === 6
              ? 4
              : 0;
  if (channels === 0) throw new Error('SOURCE_IMAGE_REJECTED');
  if (!has(bytes, bytes.length - 12, [0, 0, 0, 0, 73, 69, 78, 68]))
    throw new Error('SOURCE_POLYGLOT_REJECTED');
  imageBounds(width, height, channels * (bytes[24] === 16 ? 2 : 1));
  return true;
}
function jpeg(bytes: Uint8Array): boolean {
  if (!has(bytes, 0, [0xff, 0xd8, 0xff])) return false;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error('SOURCE_IMAGE_REJECTED');
    const marker = byte(bytes, offset + 1);
    if (marker === 0xd9 || marker === 0xda) break;
    const length = (byte(bytes, offset + 2) << 8) | byte(bytes, offset + 3);
    if (length < 2 || offset + 2 + length > bytes.length)
      throw new Error('SOURCE_IMAGE_REJECTED');
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
        marker,
      )
    ) {
      const height = (byte(bytes, offset + 5) << 8) | byte(bytes, offset + 6);
      const width = (byte(bytes, offset + 7) << 8) | byte(bytes, offset + 8);
      const channels = byte(bytes, offset + 9);
      imageBounds(width, height, channels);
      if (!has(bytes, bytes.length - 2, [0xff, 0xd9]))
        throw new Error('SOURCE_POLYGLOT_REJECTED');
      return true;
    }
    offset += 2 + length;
  }
  throw new Error('SOURCE_IMAGE_REJECTED');
}
function webp(bytes: Uint8Array): boolean {
  if (
    decodeAscii(bytes.subarray(0, 4)) !== 'RIFF' ||
    decodeAscii(bytes.subarray(8, 12)) !== 'WEBP'
  )
    return false;
  const declared = unsigned32(bytes, 4) + 8;
  if (declared !== bytes.length) throw new Error('SOURCE_IMAGE_REJECTED');
  const kind = decodeAscii(bytes.subarray(12, 16));
  let width: number;
  let height: number;
  if (kind === 'VP8X') {
    width = 1 + byte(bytes, 24) + (byte(bytes, 25) << 8) + (byte(bytes, 26) << 16);
    height = 1 + byte(bytes, 27) + (byte(bytes, 28) << 8) + (byte(bytes, 29) << 16);
  } else if (kind === 'VP8L' && bytes[20] === 0x2f) {
    const bits = unsigned32(bytes, 21);
    width = (bits & 0x3fff) + 1;
    height = ((bits >>> 14) & 0x3fff) + 1;
  } else {
    throw new Error('SOURCE_IMAGE_REJECTED');
  }
  imageBounds(width, height, 4);
  return true;
}
function pdf(bytes: Uint8Array): boolean {
  if (decodeAscii(bytes.subarray(0, 5)) !== '%PDF-') return false;
  const text = Buffer.from(bytes).toString('latin1');
  if (/\/Encrypt\b/u.test(text)) throw new Error('SOURCE_ENCRYPTED_REJECTED');
  if (!/%%EOF[\t\n\f\r ]*$/u.test(text)) throw new Error('SOURCE_POLYGLOT_REJECTED');
  return true;
}
function officeType(entries: readonly ZipEntry[]): SourceMediaType {
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const realPart = (name: string): boolean => (byName.get(name)?.uncompressedSize ?? 0) > 0;
  const xlsx = realPart('[Content_Types].xml') && realPart('xl/workbook.xml');
  const ods =
    realPart('mimetype') && realPart('content.xml') && realPart('META-INF/manifest.xml');
  if (xlsx && ods) throw new Error('SOURCE_POLYGLOT_REJECTED');
  if (xlsx) {
    if (entries.some(({ name }) => /(?:^|\/)vbaProject\.bin$/iu.test(name)))
      throw new Error('SOURCE_MACRO_REJECTED');
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  if (ods) {
    if (
      entries.some(({ name }) =>
        /^(?:Basic|Scripts|Configurations2\/accelerator\/current\.xml)(?:\/|$)/iu.test(name),
      )
    )
      throw new Error('SOURCE_MACRO_REJECTED');
    return 'application/vnd.oasis.opendocument.spreadsheet';
  }
  throw new Error('SOURCE_ARCHIVE_REJECTED');
}
function office(bytes: Uint8Array): SourceMediaType | undefined {
  if (!has(bytes, 0, ZIP_LOCAL_HEADER)) return undefined;
  return officeType(zipEntries(bytes));
}
/** Re-runs the canonical structural ZIP validation inside the processing child
 * and returns only CRC-verified entry contents. Header declarations are never
 * trusted as extracted values. */
export function readValidatedOfficeContainer(
  bytes: Uint8Array,
  expectedMediaType: SourceMediaType,
): readonly ValidatedOfficeEntry[] {
  if (!has(bytes, 0, ZIP_LOCAL_HEADER)) throw new Error('SOURCE_CONTAINER_REJECTED');
  const entries = zipEntries(bytes, true);
  if (officeType(entries) !== expectedMediaType) throw new Error('SOURCE_TYPE_MISMATCH');
  return entries.map((entry) => {
    if (entry.content === undefined) throw new Error('SOURCE_CONTAINER_REJECTED');
    return { name: entry.name, content: entry.content };
  });
}
const ACTIVE_ELEMENT_NAMES =
  'html|head|body|title|base|link|meta|style|main|section|nav|article|aside|header|footer|address|div|span|p|h[1-6]|blockquote|ol|ul|menu|li|dl|dt|dd|figure|figcaption|pre|code|br|hr|a|img|picture|iframe|object|embed|form|label|input|button|textarea|select|option|datalist|output|progress|meter|fieldset|legend|details|summary|dialog|table|caption|colgroup|col|thead|tbody|tfoot|tr|th|td|b|strong|i|em|u|s|small|sub|sup|mark|time|script|noscript|template|canvas|audio|video|source|track|svg|math';
/*
 * HTML permits any whitespace, including newlines, inside a start tag, so a tag
 * body must NOT exclude \r\n: `<img\nsrc=x\nonerror=alert(1)>` is active markup
 * that a browser executes. Excluding newlines here previously created a bypass.
 *
 * The prose/CSV exception therefore cannot come from forbidding newlines. It
 * comes from requiring a recognized element name immediately after `<`, which
 * `revenue < target` and `A < B,1` never satisfy: a comparison is followed by
 * whitespace and an operand, not an element name. An isolated `<html>` mention
 * in prose is still accepted because it is unpaired and not at the document
 * root -- see the paired/self-closing/root checks below.
 *
 * A tag body is bounded to keep matching linear and avoid a `<` in prose
 * scanning to the end of a large document looking for `>`.
 */
const TAG_BODY = '[^>]{0,4096}';
const MARKUP_TAG = new RegExp(`<\\s*(/?)\\s*(${ACTIVE_ELEMENT_NAMES})\\b(${TAG_BODY})>`, 'giu');
const ROOT_MARKUP = new RegExp(`<\\s*(?:${ACTIVE_ELEMENT_NAMES})\\b${TAG_BODY}>`, 'iy');
const XML_DOCUMENT = new RegExp(
  `<\\?xml\\b${TAG_BODY}\\?>\\s*<[A-Za-z_][\\w:.-]*(?:\\s${TAG_BODY})?>`,
  'iu',
);
/*
 * An unclosed start tag for a content-loading or scriptable element is still
 * dangerous: a browser recovers from `<script src=...` without a closing `>`
 * by continuing to parse attributes. Such a construct has no legitimate place
 * in a plain-text or CSV investor document.
 */
const DANGEROUS_UNCLOSED_TAG =
  /<\s*(?:script|iframe|object|embed|svg|math|link|meta|base|style|form|template|noscript|audio|video|source|track|canvas|img|input)\b[\s/]/iu;
function startsWithMarkupRoot(text: string): boolean {
  let cursor = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (;;) {
    while (cursor < text.length && /\s/u.test(text[cursor] ?? '')) cursor += 1;
    if (!text.startsWith('<!--', cursor)) break;
    const commentEnd = text.indexOf('-->', cursor + 4);
    if (commentEnd < 0) break;
    cursor = commentEnd + 3;
  }
  ROOT_MARKUP.lastIndex = cursor;
  return ROOT_MARKUP.test(text);
}
function containsActiveMarkup(text: string): boolean {
  if (
    /<!doctype\s+html\b/iu.test(text) ||
    XML_DOCUMENT.test(text) ||
    DANGEROUS_UNCLOSED_TAG.test(text) ||
    startsWithMarkupRoot(text)
  )
    return true;
  const opened = new Set<string>();
  for (const match of text.matchAll(MARKUP_TAG)) {
    const closing = match[1] === '/';
    const name = match[2]?.toLowerCase();
    const attributes = match[3] ?? '';
    if (name === undefined) continue;
    if (closing) {
      if (opened.has(name)) return true;
      continue;
    }
    if (
      name === 'script' ||
      /\/\s*$/u.test(attributes) ||
      /\bon[a-z][\w:-]*\s*=/iu.test(attributes)
    )
      return true;
    opened.add(name);
  }
  return false;
}
function textType(bytes: Uint8Array, binaryMatched = false): SourceMediaType {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('SOURCE_TYPE_REJECTED');
  }
  if (
    text.includes('\0') ||
    containsActiveMarkup(text) ||
    /<\?(?:php|=)/iu.test(text) ||
    /(?:^|[\r\n])\s*#!/u.test(text) ||
    /\bjavascript\s*:/iu.test(text)
  )
    throw new Error('SOURCE_ACTIVE_CONTENT_REJECTED');
  if (binaryMatched) throw new Error('SOURCE_TYPE_REJECTED');
  const lines = text.split(/\r?\n/u).filter((line) => line !== '');
  const commaCounts = lines.map((line) => line.length - line.replaceAll(',', '').length);
  const firstCommaCount = commaCounts[0] ?? 0;
  const csv =
    lines.length >= 2 &&
    firstCommaCount > 0 &&
    commaCounts.every((count) => count === firstCommaCount);
  return csv ? 'text/csv' : 'text/plain';
}

/** Detects type from bytes only and rejects ambiguous/active/container inputs. */
export function validateSourceBytes(
  bytes: Uint8Array,
  declaredMediaType: string,
): ValidatedSource {
  if (bytes.length < 1 || bytes.length > MAX_SOURCE_BYTES)
    throw new Error('SOURCE_SIZE_REJECTED');
  const binaryMatches: SourceMediaType[] = [];
  if (pdf(bytes)) binaryMatches.push('application/pdf');
  if (png(bytes)) binaryMatches.push('image/png');
  if (jpeg(bytes)) binaryMatches.push('image/jpeg');
  if (webp(bytes)) binaryMatches.push('image/webp');
  const officeType = office(bytes);
  if (officeType !== undefined) binaryMatches.push(officeType);
  let textMatch: SourceMediaType | undefined;
  try {
    textMatch = textType(bytes, binaryMatches.length > 0);
  } catch (error) {
    if (
      binaryMatches.length > 0 &&
      error instanceof Error &&
      error.message === 'SOURCE_ACTIVE_CONTENT_REJECTED'
    )
      throw new Error('SOURCE_POLYGLOT_REJECTED', { cause: error });
    if (binaryMatches.length === 0) throw error;
  }
  const matches = [...binaryMatches, ...(textMatch === undefined ? [] : [textMatch])];
  if (matches.length > 1) throw new Error('SOURCE_POLYGLOT_REJECTED');
  const detected = matches[0];
  if (detected === undefined) throw new Error('SOURCE_TYPE_REJECTED');
  if (detected !== declaredMediaType) throw new Error('SOURCE_TYPE_MISMATCH');
  return {
    mediaType: detected,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
