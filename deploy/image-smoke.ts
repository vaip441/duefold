import { spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { sandboxProgram } from '../modules/rooms-documents/src/processing/sandbox.ts';
import { composeWatermarkPage } from '../modules/rooms-documents/src/protected-delivery.ts';
import { processWatermarkEnvelope } from '../modules/rooms-documents/src/processing/watermark-adapter.ts';
import {
  createProcessorPrograms,
  processSource,
  type ProcessedDocument,
} from '../modules/rooms-documents/src/processing/formats.ts';

const XLSX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const limits = {
  timeoutMilliseconds: 30_000,
  maximumInputBytes: 1024 * 1024,
  maximumOutputBytes: 4 * 1024 * 1024,
  maximumTemporaryBytes: 64 * 1024 * 1024,
};
const PNG_SIGNATURE = '89504e470d0a1a0a';

function crc32(buffer: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(variant = 0): Buffer {
  const width = 320;
  const height = 200;
  const chunks: Buffer[] = [Buffer.from(PNG_SIGNATURE, 'hex')];
  const chunk = (type: string, data: Buffer): void => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(data.length);
    header.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
    chunks.push(header, data, crc);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  chunk('IHDR', ihdr);
  const rowSize = width * 3 + 1;
  const rows = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y += 1) {
    rows[y * rowSize] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = y * rowSize + 1 + x * 3;
      rows[offset] = (x * 7 + variant * 61) % 256;
      rows[offset + 1] = (y * 11 + variant * 97) % 256;
      rows[offset + 2] = ((x + y) * 5 + variant * 37) % 256;
    }
  }
  chunk('IDAT', deflateSync(rows));
  chunk('IEND', Buffer.alloc(0));
  return Buffer.concat(chunks);
}

function assertPng(image: Buffer, code: string): void {
  if (image.subarray(0, 8).toString('hex') !== PNG_SIGNATURE) throw new Error(code);
}

function storedZip(entries: Readonly<Record<string, string>>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name);
    const content = Buffer.from(value);
    const checksum = crc32(content);
    const local = Buffer.alloc(30 + nameBytes.length + content.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(checksum, 14);
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
    central.writeUInt32LE(checksum, 16);
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

function xlsxFixture(): Buffer {
  return storedZip({
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels':
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml':
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Visible" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml':
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Duefold workbook smoke</t></is></c><c r="B1"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>',
  });
}

const processorPrograms = createProcessorPrograms({
  pdf: '/usr/bin/mutool',
  office: '/usr/lib/libreoffice/program/soffice.bin',
  image: '/usr/bin/magick-im7.q16',
  text: '/usr/bin/magick-im7.q16',
});

function processFixture(
  mediaType: Parameters<typeof processSource>[0]['mediaType'],
  input: Buffer,
) {
  return processSource({
    mediaType,
    bytes: input,
    programs: processorPrograms,
    limits,
  }).catch((error: unknown) => {
    const code = error instanceof Error ? error.message : 'UNKNOWN';
    throw new Error(`WORKER_${mediaType.toUpperCase().replace(/[^A-Z0-9]+/gu, '_')}:${code}`);
  });
}

function firstPage(output: ProcessedDocument, code: string): Buffer {
  const page = output.pages[0];
  const image = Buffer.from(page?.image ?? []);
  if (page?.mediaType !== 'image/png') throw new Error(code);
  assertPng(image, code);
  return image;
}

function verifyImageMagickPolicy(): void {
  const tool = '/usr/bin/magick-im7.q16';
  const policy = spawnSync(tool, ['-list', 'policy'], { encoding: 'utf8' });
  if (policy.status !== 0 || !policy.stdout.includes('Policy: Coder'))
    throw new Error('IMAGEMAGICK_POLICY_NOT_LOADED');
  for (const [name, pattern] of [
    ['SVG', 'SVG'],
    ['URL', 'URL'],
    ['filesystem @path', '@*'],
  ] as const)
    if (!policy.stdout.includes(pattern))
      throw new Error(`IMAGEMAGICK_POLICY_RULE_MISSING:${name}`);
  const denied = [
    { arguments: ['svg:-', 'png:-'], input: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
    { arguments: ['https://example.com/image.png', 'png:-'], input: '' },
    { arguments: ['-size', '32x32', 'caption:@/etc/passwd', 'png:-'], input: '' },
  ];
  for (const probe of denied) {
    const result = spawnSync(tool, probe.arguments, {
      input: probe.input,
      encoding: 'utf8',
      timeout: 5_000,
    });
    if (result.status === 0) throw new Error('IMAGEMAGICK_POLICY_DENIAL_FAILED');
  }
}

const mode = process.argv[2];
verifyImageMagickPolicy();
if (mode === 'web') {
  const source = png();
  const alternate = png(1);
  const envelope = JSON.stringify({
    watermark: {
      email: 'smoke@example.com',
      accessDateUtc: '2026-01-01',
      roomName: 'Smoke 投資家 @/etc/passwd 100% %[exif:*]',
    },
    imageBase64: source.toString('base64'),
  });
  assertPng(
    await processWatermarkEnvelope('/usr/bin/magick-im7.q16', envelope),
    'WEB_DIRECT_IMAGE_SMOKE_FAILED',
  );
  const watermark = {
    program: sandboxProgram(process.execPath, [
      fileURLToPath(
        new URL(
          '../modules/rooms-documents/src/processing/watermark-adapter.ts',
          import.meta.url,
        ),
      ),
      '/usr/bin/magick-im7.q16',
    ]),
    viewerEmail: 'smoke@example.com',
    accessDateUtc: '2026-01-01',
    roomName: 'Smoke 投資家 @/etc/passwd 100% %[exif:*]',
  } as const;
  const [output, alternateOutput] = await Promise.all([
    composeWatermarkPage({ ...watermark, source }),
    composeWatermarkPage({ ...watermark, source: alternate }),
  ]);
  assertPng(Buffer.from(output), 'WEB_IMAGE_SMOKE_FAILED');
  if (Buffer.from(output).equals(Buffer.from(alternateOutput)))
    throw new Error('WEB_IMAGE_SOURCE_CONTENT_LOST');
} else if (mode === 'worker') {
  const textPage = firstPage(
    await processFixture(
      'text/plain',
      Buffer.from('Synthetic document\n投資家向け資料\n@/etc/passwd 100% %[exif:*]'),
    ),
    'WORKER_TEXT_SMOKE_FAILED',
  );
  const imageSource = png();
  const imagePage = firstPage(
    await processFixture('image/png', imageSource),
    'WORKER_IMAGE_SMOKE_FAILED',
  );
  if (imagePage.equals(imageSource)) throw new Error('WORKER_IMAGE_REENCODE_NOT_PROVEN');

  // Minimal one-page PDF with a visible vector rectangle and text. MuPDF must
  // rasterize it through the same sandboxed adapter used by production jobs.
  const stream = '0 0 1 rg 36 36 120 72 re f BT /F1 18 Tf 48 72 Td (Duefold smoke) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 150] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${String(Buffer.byteLength(stream))} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1))
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  firstPage(
    await processFixture('application/pdf', Buffer.from(pdf)),
    'WORKER_PDF_SMOKE_FAILED',
  );
  firstPage(await processFixture(XLSX_MEDIA_TYPE, xlsxFixture()), 'WORKER_XLSX_SMOKE_FAILED');
  if (textPage.length === 0) throw new Error('WORKER_TEXT_SMOKE_FAILED');
} else throw new Error('usage: image-smoke web|worker');

process.stdout.write(`${mode} image smoke passed\n`);
