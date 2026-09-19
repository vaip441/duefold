import { describe, expect, it } from 'vitest';
import {
  MAX_DIRECTORY_FILES,
  MAX_MULTIPART_PARTS,
  MAX_SOURCE_BYTES,
  MIN_MULTIPART_PART_BYTES,
  validateDeclaredSourceSize,
  validateMultipartPlan,
} from './resource-policy.ts';
import { preflightDirectoryUpload } from './preflight.ts';
import { validateSourceBytes } from './source-validation.ts';

function png(width: number, height: number): Uint8Array {
  const bytes = Buffer.alloc(45);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  Buffer.from([0, 0, 0, 0, 73, 69, 78, 68]).copy(bytes, 33);
  return bytes;
}
const CRC32_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1)
    crc = (crc & 1) === 0 ? crc >>> 1 : 0xedb88320 ^ (crc >>> 1);
  return crc >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of bytes) crc = (CRC32_TABLE[(crc ^ value) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function storedZip(entries: Readonly<Record<string, string>>): Uint8Array {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name);
    const content = Buffer.from(value);
    const crc = crc32(content);
    const local = Buffer.alloc(30 + nameBytes.length + content.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    content.copy(local, 30 + nameBytes.length);
    localParts.push(local);
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(localOffset, 42);
    nameBytes.copy(central, 46);
    centralParts.push(central);
    localOffset += local.length;
  }
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centralParts.length, 8);
  end.writeUInt16LE(centralParts.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}
function forgedCentralDirectory(): Uint8Array {
  const parts = [Buffer.from([0x50, 0x4b, 0x03, 0x04])];
  for (const name of ['[Content_Types].xml', 'xl/workbook.xml']) {
    const header = Buffer.alloc(46 + Buffer.byteLength(name));
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt32LE(1, 20);
    header.writeUInt32LE(1, 24);
    header.writeUInt16LE(Buffer.byteLength(name), 28);
    header.write(name, 46);
    parts.push(header);
  }
  return Buffer.concat(parts);
}
describe('fixed source resource policy', () => {
  it('accepts exactly 250 MiB declarations and rejects one byte over before planning', () => {
    expect(() => {
      validateDeclaredSourceSize(MAX_SOURCE_BYTES);
    }).not.toThrow();
    expect(() => {
      validateDeclaredSourceSize(MAX_SOURCE_BYTES + 1);
    }).toThrow('SOURCE_SIZE_REJECTED');
  });
  it('derives the maximum part count and rejects inconsistent plans', () => {
    expect(MAX_MULTIPART_PARTS).toBe(Math.ceil(MAX_SOURCE_BYTES / MIN_MULTIPART_PART_BYTES));
    const plan = Array.from({ length: MAX_MULTIPART_PARTS }, (_, index) => ({
      partNumber: index + 1,
      size: MIN_MULTIPART_PART_BYTES,
    }));
    expect(() => {
      validateMultipartPlan(MAX_SOURCE_BYTES, plan, false);
    }).not.toThrow();
    expect(() => {
      validateMultipartPlan(MAX_SOURCE_BYTES, [...plan, { partNumber: 51, size: 1 }], false);
    }).toThrow('PART_PLAN_REJECTED');
    expect(() => {
      validateMultipartPlan(6, [{ partNumber: 1, size: 5 }], false);
    }).toThrow('PART_PLAN_REJECTED');
  });
});
describe('directory preflight', () => {
  it('normalizes paths and rejects traversal, collisions, unsupported files, count and aggregate overflow', () => {
    expect(preflightDirectoryUpload([{ path: 'Folder/File.PDF', size: 1 }])[0]?.path).toBe(
      'Folder/File.PDF',
    );
    expect(() => preflightDirectoryUpload([{ path: '../file.pdf', size: 1 }])).toThrow();
    expect(() =>
      preflightDirectoryUpload([
        { path: 'file.pdf', size: 1 },
        { path: 'FILE.pdf', size: 1 },
      ]),
    ).toThrow('PREFLIGHT_COLLISION_REJECTED');
    expect(() => preflightDirectoryUpload([{ path: 'archive.zip', size: 1 }])).toThrow();
    expect(() =>
      preflightDirectoryUpload(
        Array.from({ length: MAX_DIRECTORY_FILES + 1 }, (_, index) => ({
          path: `file-${index}.pdf`,
          size: 1,
        })),
      ),
    ).toThrow('PREFLIGHT_COUNT_REJECTED');
    expect(() =>
      preflightDirectoryUpload(
        Array.from({ length: 41 }, (_, index) => ({
          path: `aggregate-${index}.pdf`,
          size: MAX_SOURCE_BYTES,
        })),
      ),
    ).toThrow('PREFLIGHT_TOTAL_SIZE_REJECTED');
    expect(
      preflightDirectoryUpload([
        { path: 'комната/файл.pdf', size: 1 },
        { path: '資料/報告.pdf', size: 1 },
        { path: '資料/投資家向けレポート.xlsx', size: 1 },
        { path: '자료/投資보고서.csv', size: 1 },
      ]).map(({ path }) => path),
    ).toEqual([
      'комната/файл.pdf',
      '資料/報告.pdf',
      '資料/投資家向けレポート.xlsx',
      '자료/投資보고서.csv',
    ]);
    expect(preflightDirectoryUpload([{ path: 'room/а.pdf', size: 1 }])[0]?.path).toBe(
      'room/а.pdf',
    );
    expect(() => preflightDirectoryUpload([{ path: 'room/rеport.pdf', size: 1 }])).toThrow(
      'PREFLIGHT_CONFUSABLE_REJECTED',
    );
    expect(() =>
      preflightDirectoryUpload([
        { path: 'room/a.pdf', size: 1 },
        { path: 'room/а.pdf', size: 1 },
      ]),
    ).toThrow('PREFLIGHT_CONFUSABLE_REJECTED');
  });
});
describe('content-based source validation', () => {
  it('detects UTF-8 text/CSV and rejects declared mismatches, HTML, SVG, and invalid UTF-8', () => {
    expect(validateSourceBytes(Buffer.from('hello'), 'text/plain').mediaType).toBe(
      'text/plain',
    );
    expect(validateSourceBytes(Buffer.from('a,b\n1,2\n'), 'text/csv').mediaType).toBe(
      'text/csv',
    );
    expect(() => validateSourceBytes(Buffer.from('hello'), 'application/pdf')).toThrow(
      'SOURCE_TYPE_MISMATCH',
    );
    expect(
      validateSourceBytes(Buffer.from('metric,value\nA < B,1\nC > D,2\n'), 'text/csv')
        .mediaType,
    ).toBe('text/csv');
    expect(
      validateSourceBytes(
        Buffer.from('The report mentions <html> as a literal token.\n'),
        'text/plain',
      ).mediaType,
    ).toBe('text/plain');
    expect(() => validateSourceBytes(Buffer.from('<html>bad'), 'text/plain')).toThrow(
      'SOURCE_ACTIVE_CONTENT_REJECTED',
    );
    expect(() =>
      validateSourceBytes(Buffer.from('<!--x--><html>bad</html>'), 'text/plain'),
    ).toThrow('SOURCE_ACTIVE_CONTENT_REJECTED');
    expect(() =>
      validateSourceBytes(Buffer.from('<!--x--><svg onload="x()"></svg>'), 'text/plain'),
    ).toThrow('SOURCE_ACTIVE_CONTENT_REJECTED');
    expect(() =>
      validateSourceBytes(Buffer.from('prefix\n<svg onload="x()"/>'), 'text/plain'),
    ).toThrow('SOURCE_ACTIVE_CONTENT_REJECTED');
    // HTML allows newlines and tabs inside a start tag, so a tag body must not
    // exclude them. Excluding \r\n once let all four of these through while a
    // single-line equivalent was rejected.
    for (const multiline of [
      'Report\n<script\nsrc="https://example.invalid/p.js"></script>',
      'Report\n<iframe\nsrc="https://example.invalid/"></iframe>',
      'Report\n<img\nsrc=x\nonerror=alert(1)>',
      'Report\n<svg\nonload=alert(1)>payload</svg>',
      'Report\n<img\tsrc=x\tonerror=alert(1)>',
      'a\n<iframe\n  src="https://x.invalid"\n  width="1"\n></iframe>',
      // div/span are not content-loading elements, so only the tag-body rule
      // catches these. They fail if a tag body stops spanning newlines again.
      'Report\n<div\nonclick=alert(1)>x</div>',
      'Report\n<span\nonmouseover=alert(1)>x</span>',
      'Report\n<div\nclass="a">x</div>',
    ])
      expect(() => validateSourceBytes(Buffer.from(multiline), 'text/plain')).toThrow(
        'SOURCE_ACTIVE_CONTENT_REJECTED',
      );
    // A browser recovers from an unterminated start tag, so it stays dangerous.
    expect(() =>
      validateSourceBytes(
        Buffer.from('<!--x--><script src="https://example.invalid/p.js"'),
        'text/plain',
      ),
    ).toThrow('SOURCE_ACTIVE_CONTENT_REJECTED');
    // Prose that merely discusses markup, and multi-line comparisons, stay valid.
    for (const [benign, declared] of [
      ['revenue < target\nmargin > forecast\n', 'text/plain'],
      ['We reviewed the script and iframe usage policy.\n', 'text/plain'],
      ['metric,value\nA < B,1\nC > D,2\n', 'text/csv'],
    ] as const)
      expect(validateSourceBytes(Buffer.from(benign), declared).mediaType).toBe(declared);
    expect(validateSourceBytes(Buffer.from('x < y and y > z'), 'text/plain').mediaType).toBe(
      'text/plain',
    );
    expect(() => validateSourceBytes(Buffer.from('#!/bin/sh\necho bad'), 'text/plain')).toThrow(
      'SOURCE_ACTIVE_CONTENT_REJECTED',
    );
    expect(() => validateSourceBytes(Buffer.from('<?php echo 1;'), 'text/plain')).toThrow(
      'SOURCE_ACTIVE_CONTENT_REJECTED',
    );
    expect(() => validateSourceBytes(Uint8Array.from([0xff]), 'text/plain')).toThrow(
      'SOURCE_TYPE_REJECTED',
    );
  });
  it('validates real ZIP structure and rejects archives, macros, and forged entries', () => {
    const xlsx = storedZip({
      '[Content_Types].xml': '<Types/>',
      'xl/workbook.xml': '<workbook/>',
    });
    expect(
      validateSourceBytes(
        xlsx,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ).mediaType,
    ).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(() =>
      validateSourceBytes(
        forgedCentralDirectory(),
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ),
    ).toThrow('SOURCE_CONTAINER_REJECTED');
    expect(() => validateSourceBytes(storedZip({ 'note.txt': 'hello' }), 'text/plain')).toThrow(
      'SOURCE_ARCHIVE_REJECTED',
    );
    expect(() =>
      validateSourceBytes(
        storedZip({
          '[Content_Types].xml': '<Types/>',
          'xl/workbook.xml': '<workbook/>',
          'xl/vbaProject.bin': 'real macro bytes',
        }),
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ),
    ).toThrow('SOURCE_MACRO_REJECTED');
  });
  it('rejects a valid binary with an active-text interpretation as a polyglot', () => {
    expect(() =>
      validateSourceBytes(
        Buffer.from('%PDF-1.7\n<script>alert(1)</script>\n%%EOF\n'),
        'application/pdf',
      ),
    ).toThrow('SOURCE_POLYGLOT_REJECTED');
  });
  it('reads image dimensions from headers and rejects decompression bombs before decode', () => {
    expect(validateSourceBytes(png(8_000, 8_000), 'image/png').mediaType).toBe('image/png');
    expect(() => validateSourceBytes(png(8_001, 8_000), 'image/png')).toThrow(
      'SOURCE_RESOURCE_REJECTED',
    );
  });
  it('rejects PDF trailing polyglot bytes and encryption markers', () => {
    expect(
      validateSourceBytes(Buffer.from('%PDF-1.7\n%%EOF\n'), 'application/pdf').mediaType,
    ).toBe('application/pdf');
    expect(() =>
      validateSourceBytes(Buffer.from('%PDF-1.7\n%%EOF\n<script>'), 'application/pdf'),
    ).toThrow('SOURCE_POLYGLOT_REJECTED');
    expect(() =>
      validateSourceBytes(Buffer.from('%PDF-1.7\n/Encrypt 1 0 R\n%%EOF'), 'application/pdf'),
    ).toThrow('SOURCE_ENCRYPTED_REJECTED');
  });
});
