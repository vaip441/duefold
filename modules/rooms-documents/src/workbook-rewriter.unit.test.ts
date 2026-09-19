import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { processSource } from './processing/formats.ts';
import { sandboxProgram } from './processing/sandbox.ts';
import { readValidatedOfficeContainer } from './source-validation.ts';
import { rewriteWorkbook } from './processing/workbook-rewriter.ts';
import { libreOfficeArguments } from './processing/workbook-adapter.ts';

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
const xlsxType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const odsType = 'application/vnd.oasis.opendocument.spreadsheet';
const spreadsheetNamespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const relationshipNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
const officeRelationshipNamespace =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const contentTypesNamespace = 'http://schemas.openxmlformats.org/package/2006/content-types';
const markupCompatibilityNamespace =
  'http://schemas.openxmlformats.org/markup-compatibility/2006';
const x14acNamespace = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac';
const x15Namespace = 'http://schemas.microsoft.com/office/spreadsheetml/2010/11/main';
const revision6Namespace = 'http://schemas.microsoft.com/office/spreadsheetml/2016/revision6';
const odfNamespaces =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:xlink="http://www.w3.org/1999/xlink"';
const workbookFixture = new URL(
  '../../../test/fixtures/processors/workbook-rewriter-fixture.ts',
  import.meta.url,
).pathname;
const workbookAdapter = new URL('./processing/workbook-adapter.ts', import.meta.url).pathname;
const workbookRewriter = new URL('./processing/workbook-rewriter.ts', import.meta.url).pathname;
const sourceValidation = new URL('./source-validation.ts', import.meta.url).pathname;
const resourcePolicy = new URL('./resource-policy.ts', import.meta.url).pathname;
/** Runs the real workbook adapter against fake soffice.bin and mutool programs
 * that reproduce LibreOffice's first-start restart and silent export failure. */
async function runWorkbookAdapter(behaviour: 'restart' | 'no-pdf'): Promise<unknown> {
  const directory = await mkdtemp(join(tmpdir(), 'duefold-adapter-test-'));
  try {
    const office = join(directory, 'soffice.mjs');
    const renderer = join(directory, 'mutool.mjs');
    await writeFile(
      office,
      `#!${process.execPath}
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const args = process.argv.slice(2);
if (process.env.LD_LIBRARY_PATH !== dirname(process.argv[1])) process.exit(3);
const profile = args.find((value) => value.startsWith('-env:UserInstallation=file://')).slice(29);
if (!existsSync(profile)) { mkdirSync(profile); process.exit(81); }
if (${JSON.stringify(behaviour)} === 'restart')
  writeFileSync(join(args[args.indexOf('--outdir') + 1], 'source.pdf'), '%PDF-1.4');
`,
      { mode: 0o755 },
    );
    await writeFile(
      renderer,
      `#!${process.execPath}
import { existsSync, writeFileSync } from 'node:fs';
if (!existsSync(process.argv.at(-1))) process.exit(4);
writeFileSync('page-0001.png', Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex'));
`,
      { mode: 0o755 },
    );
    const stdout = execFileSync(process.execPath, [workbookAdapter, office, renderer, 'xlsx'], {
      input: xlsx(),
      encoding: 'utf8',
    });
    return JSON.parse(stdout) as unknown;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
function content(
  bytes: Uint8Array,
  type: typeof xlsxType | typeof odsType,
): Map<string, string> {
  return new Map(
    readValidatedOfficeContainer(bytes, type).map((entry) => [
      entry.name,
      Buffer.from(entry.content).toString(),
    ]),
  );
}
function xlsx(overrides: Readonly<Record<string, string>> = {}): Uint8Array {
  return storedZip({
    '[Content_Types].xml': `<Types xmlns="${contentTypesNamespace}"><Override PartName="/xl/workbook.xml"/><Override PartName="/xl/worksheets/sheet1.xml"/><Override PartName="/xl/worksheets/sheet2.xml"/><Override PartName="/xl/worksheets/sheet3.xml"/></Types>`,
    'xl/workbook.xml': `<workbook xmlns="${spreadsheetNamespace}" xmlns:r="${officeRelationshipNamespace}"><definedNames><definedName name="Outside">[1]Sheet!A1</definedName></definedNames><sheets><sheet name="Visible" sheetId="1" r:id="rId1"/><sheet name="Hidden" sheetId="2" state="hidden" r:id="rId2"/><sheet name="Very hidden" sheetId="3" state="veryHidden" r:id="rId3"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${relationshipNamespace}"><Relationship Id="rId1" Type="${officeRelationshipNamespace}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${officeRelationshipNamespace}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${officeRelationshipNamespace}/worksheet" Target="worksheets/sheet3.xml"/><Relationship Id="rExt" Type="externalLink" Target="externalLinks/externalLink1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="${spreadsheetNamespace}" xmlns:r="${officeRelationshipNamespace}"><sheetData><row><c r="A1"><f>SUM(B1:B2)</f><v>42</v></c><c r="A2"><f>NOW()</f></c></row></sheetData><oleObjects><oleObject r:id="ole"/></oleObjects></worksheet>`,
    'xl/worksheets/_rels/sheet1.xml.rels': `<Relationships xmlns="${relationshipNamespace}"><Relationship Id="ole" Type="oleObject" Target="../embeddings/oleObject1.bin"/><Relationship Id="dde" Type="externalLink" Target="../externalLinks/externalLink1.xml"/><Relationship Id="remote" Type="image" TargetMode="External" Target="http://remote.invalid/image.png"/><Relationship Id="credentials" Type="hyperlink" TargetMode="External" Target="https://user:secret@example.com/"/><Relationship Id="safe" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" TargetMode="External" Target="https://example.com/"/></Relationships>`,
    'xl/worksheets/sheet2.xml': `<worksheet xmlns="${spreadsheetNamespace}"><sheetData><row><c r="A1"><v>secret</v></c></row></sheetData></worksheet>`,
    'xl/worksheets/sheet3.xml': `<worksheet xmlns="${spreadsheetNamespace}"><sheetData><row><c r="A1"><v>very secret</v></c></row></sheetData></worksheet>`,
    'xl/externalLinks/externalLink1.xml': `<externalLink xmlns="${spreadsheetNamespace}"><ddeLink ddeService="x"/></externalLink>`,
    'xl/embeddings/oleObject1.bin': 'ole',
    ...overrides,
  });
}
function excelAuthoredXlsx(): Uint8Array {
  return storedZip({
    '[Content_Types].xml': `<Types xmlns="${contentTypesNamespace}"><Override PartName="/xl/workbook.xml"/><Override PartName="/xl/styles.xml"/><Override PartName="/xl/sharedStrings.xml"/><Override PartName="/xl/worksheets/sheet1.xml"/><Override PartName="/xl/worksheets/sheet2.xml"/><Override PartName="/xl/worksheets/sheet3.xml"/><Override PartName="/docProps/app.xml"/><Override PartName="/docProps/custom.xml"/></Types>`,
    'xl/workbook.xml': `<workbook xmlns="${spreadsheetNamespace}" xmlns:r="${officeRelationshipNamespace}" xmlns:mc="${markupCompatibilityNamespace}" xmlns:x15="${x15Namespace}" xmlns:xr6="${revision6Namespace}" mc:Ignorable="x15 xr6" xr6:uid="{00000000-0000-0000-0000-000000000001}"><sheets><sheet name="Summary" sheetId="1" r:id="rId1"/><sheet name="Detail" sheetId="2" r:id="rId2"/><sheet name="Notes" sheetId="3" r:id="rId3"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${relationshipNamespace}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/><Relationship Id="rStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rStrings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    'xl/styles.xml': `<styleSheet xmlns="${spreadsheetNamespace}" xmlns:mc="${markupCompatibilityNamespace}" xmlns:x14ac="${x14acNamespace}" mc:Ignorable="x14ac"><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="#,#00.00"/></numFmts><fonts count="1" x14ac:knownFonts="1"><font><sz val="11"/><name val="Aptos"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`,
    'xl/sharedStrings.xml': `<sst xmlns="${spreadsheetNamespace}" count="3" uniqueCount="3"><si><t>Revenue</t></si><si><t xml:space="preserve">Line one&#10;Line two</t></si><si><t>Detail value</t></si></sst>`,
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="${spreadsheetNamespace}" xmlns:r="${officeRelationshipNamespace}" xmlns:mc="${markupCompatibilityNamespace}" xmlns:x14ac="${x14acNamespace}" xmlns:x15="${x15Namespace}" mc:Ignorable="x14ac x15"><dimension ref="A1:C3"/><sheetData><row r="1" spans="1:3" x14ac:dyDescent="0.25"><c r="A1" t="s"><v>0</v></c><c r="B1" s="1"><v>45567</v></c><c r="C1" s="2"><v>12345.67</v></c></row><row r="2" x14ac:dyDescent="0.25"><c r="A2" t="s"><v>1</v></c><c r="B2"><f>SUM(C1:C1)</f><v>12345.67</v></c></row></sheetData><hyperlinks><hyperlink ref="A1" r:id="safeLink"/></hyperlinks><mc:AlternateContent><mc:Choice Requires="x15"><x15:timelineRefs/></mc:Choice><mc:Fallback><extLst><ext uri="unsafe"><f>WEBSERVICE(&quot;https://attacker.invalid&quot;)</f></ext></extLst></mc:Fallback></mc:AlternateContent></worksheet>`,
    'xl/worksheets/_rels/sheet1.xml.rels': `<Relationships xmlns="${relationshipNamespace}"><Relationship Id="safeLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" TargetMode="External" Target="https://example.com/report"/></Relationships>`,
    'xl/worksheets/sheet2.xml': `<worksheet xmlns="${spreadsheetNamespace}" xmlns:x14ac="${x14acNamespace}"><sheetData><row x14ac:dyDescent="0.25"><c r="A1" t="s"><v>2</v></c></row></sheetData></worksheet>`,
    'xl/worksheets/sheet3.xml': `<worksheet xmlns="${spreadsheetNamespace}"><sheetData><row><c r="A1" t="inlineStr"><is><t>Reviewed</t></is></c></row></sheetData></worksheet>`,
    'docProps/app.xml':
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Excel</Application></Properties>',
    'docProps/custom.xml':
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties"><property name="Internal"><vt:lpwstr xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">metadata</vt:lpwstr></property></Properties>',
  });
}
function ods(overrides: Readonly<Record<string, string>> = {}): Uint8Array {
  return storedZip({
    mimetype: 'application/vnd.oasis.opendocument.spreadsheet',
    'META-INF/manifest.xml':
      '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>',
    'content.xml': `<office:document-content ${odfNamespaces}><office:body><office:spreadsheet><table:named-expressions><table:named-range table:name="Outside" table:cell-range-address="file:///outside#$Sheet.A1"/></table:named-expressions><table:table table:name="Visible"><table:table-row><table:table-cell table:formula="of:=SUM([.B1:.B2])" office:value-type="float" office:value="42"><text:p>42</text:p></table:table-cell><table:table-cell table:formula="of:=NOW()"/></table:table-row><table:dde-links><table:dde-link/></table:dde-links><draw:image xlink:href="http://remote.invalid/image.png"/></table:table><table:table table:name="Hidden" table:display="false"><table:table-row><table:table-cell office:string-value="secret"/></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>`,
    ...overrides,
  });
}

describe('structural workbook rewriting', () => {
  it('accepts representative Excel-authored metadata while preserving displayed values', () => {
    const rewritten = rewriteWorkbook(excelAuthoredXlsx(), xlsxType);
    expect(rewritten.hiddenSheets).toEqual([]);
    const entries = content(rewritten.bytes, xlsxType);
    expect(entries.get('xl/sharedStrings.xml')).toContain('Revenue');
    expect(entries.get('xl/sharedStrings.xml')).toContain('Line one&#10;Line two');
    expect(entries.get('xl/styles.xml')).toMatch(/yyyy-mm-dd|#,#00\.00/u);
    expect(entries.get('xl/worksheets/sheet1.xml')).toContain('<v>45567</v>');
    expect(entries.get('xl/worksheets/sheet1.xml')).toContain('<v>12345.67</v>');
    expect(entries.get('xl/worksheets/sheet2.xml')).toContain('<v>2</v>');
    expect(entries.get('xl/worksheets/sheet3.xml')).toContain('<t>Reviewed</t>');
    expect(entries.get('xl/worksheets/_rels/sheet1.xml.rels')).toContain(
      'https://example.com/report',
    );
    expect(entries.get('xl/worksheets/sheet1.xml')).not.toMatch(
      /mc:Ignorable|x14ac:dyDescent|AlternateContent|timelineRefs|WEBSERVICE|<f>/u,
    );
    expect(entries.has('docProps/app.xml')).toBe(false);
    expect(entries.has('docProps/custom.xml')).toBe(false);
  });
  it('preserves XLSX cached values, empties missing caches, removes hidden sheets and external content', () => {
    const rewritten = rewriteWorkbook(xlsx(), xlsxType);
    expect(rewritten.hiddenSheets).toEqual(['Hidden', 'Very hidden']);
    const entries = content(rewritten.bytes, xlsxType);
    expect(entries.get('xl/worksheets/sheet1.xml')).toContain('<v>42</v>');
    expect(entries.get('xl/worksheets/sheet1.xml')).not.toMatch(/<f>|SUM|NOW|oleObject/u);
    expect(entries.get('xl/workbook.xml')).not.toMatch(/definedName|Hidden|Very hidden/u);
    expect(entries.has('xl/worksheets/sheet2.xml')).toBe(false);
    expect(entries.has('xl/worksheets/sheet3.xml')).toBe(false);
    expect(entries.has('xl/externalLinks/externalLink1.xml')).toBe(false);
    expect(entries.has('xl/embeddings/oleObject1.bin')).toBe(false);
    const relationships = entries.get('xl/worksheets/_rels/sheet1.xml.rels') ?? '';
    expect(relationships).toContain('https://example.com/');
    expect(relationships).not.toMatch(/remote|credentials|ole|dde/iu);
  });
  it('asserts upstream macro rejection and strips non-macro embedded objects', () => {
    expect(() => rewriteWorkbook(xlsx({ 'xl/vbaProject.bin': 'macro' }), xlsxType)).toThrow(
      'SOURCE_MACRO_REJECTED',
    );
    const rewritten = rewriteWorkbook(xlsx(), xlsxType);
    expect(content(rewritten.bytes, xlsxType).has('xl/embeddings/oleObject1.bin')).toBe(false);
  });
  it('preserves ODS cached values while removing formulas, hidden sheets, DDE and remote images', () => {
    const rewritten = rewriteWorkbook(ods(), odsType);
    expect(rewritten.hiddenSheets).toEqual(['Hidden']);
    const xml = content(rewritten.bytes, odsType).get('content.xml') ?? '';
    expect(xml).toContain('office:value="42"');
    expect(xml).toContain('<text:p>42</text:p>');
    expect(xml).not.toMatch(/table:formula|table:dde|named-range|remote\.invalid|secret/u);
  });
  it.each([
    '<!DOCTYPE worksheet [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">&xxe;</worksheet>',
    '<!DOCTYPE worksheet [<!ENTITY a "ha"><!ENTITY b "&a;&a;">]><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">&b;</worksheet>',
    `<worksheet xmlns="${spreadsheetNamespace}">&unknown;</worksheet>`,
  ])('rejects entity-bearing XML without expansion: %s', (payload) => {
    expect(() =>
      rewriteWorkbook(xlsx({ 'xl/worksheets/sheet1.xml': payload }), xlsxType),
    ).toThrow('WORKBOOK_XML_ENTITY_REJECTED');
  });
  it('sanitizes prefixed XLSX names and reports prefixed hidden sheets', () => {
    const rewritten = rewriteWorkbook(
      xlsx({
        'xl/workbook.xml': `<x:workbook xmlns:x="${spreadsheetNamespace}" xmlns:p="${officeRelationshipNamespace}"><x:definedNames><x:definedName name="Outside">[1]Sheet!A1</x:definedName></x:definedNames><x:sheets><x:sheet name="Visible" sheetId="1" p:id="rId1"/><x:sheet name="Hidden" sheetId="2" state="hidden" p:id="rId2"/><x:sheet name="Very hidden" sheetId="3" state="veryHidden" p:id="rId3"/></x:sheets></x:workbook>`,
        'xl/_rels/workbook.xml.rels': `<p:Relationships xmlns:p="${relationshipNamespace}"><p:Relationship Id="rId1" Type="${officeRelationshipNamespace}/worksheet" Target="worksheets/sheet1.xml"/><p:Relationship Id="rId2" Type="${officeRelationshipNamespace}/worksheet" Target="worksheets/sheet2.xml"/><p:Relationship Id="rId3" Type="${officeRelationshipNamespace}/worksheet" Target="worksheets/sheet3.xml"/><p:Relationship Id="rExt" Type="externalLink" Target="externalLinks/externalLink1.xml"/></p:Relationships>`,
        'xl/worksheets/sheet1.xml': `<x:worksheet xmlns:x="${spreadsheetNamespace}"><x:sheetData><x:row><x:c r="A1"><x:f>WEBSERVICE(&quot;https://attacker.invalid&quot;)</x:f><x:v>cached</x:v></x:c></x:row></x:sheetData></x:worksheet>`,
      }),
      xlsxType,
    );
    expect(rewritten.hiddenSheets).toEqual(['Hidden', 'Very hidden']);
    const entries = content(rewritten.bytes, xlsxType);
    expect(entries.get('xl/workbook.xml')).not.toMatch(/definedName|Hidden|Very hidden/u);
    expect(entries.get('xl/worksheets/sheet1.xml')).toContain('<x:v>cached</x:v>');
    expect(entries.get('xl/worksheets/sheet1.xml')).not.toMatch(/WEBSERVICE|<x:f/u);
  });
  it('sanitizes alternate ODS prefixes identically', () => {
    const rewritten = rewriteWorkbook(
      ods({
        'content.xml': `<o:document-content xmlns:o="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:t="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:z="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:l="http://www.w3.org/1999/xlink"><o:body><o:spreadsheet><t:named-expressions><t:named-range t:name="Outside"/></t:named-expressions><t:table t:name="Visible"><t:table-row><t:table-cell t:formula="of:=WEBSERVICE(&quot;https://attacker.invalid&quot;)" o:string-value="cached"><z:p>cached</z:p></t:table-cell></t:table-row><t:table-source l:href="https://attacker.invalid/data"/></t:table><t:table t:name="Hidden" t:display="false"><t:table-row><t:table-cell o:string-value="secret"/></t:table-row></t:table></o:spreadsheet></o:body></o:document-content>`,
      }),
      odsType,
    );
    expect(rewritten.hiddenSheets).toEqual(['Hidden']);
    const xml = content(rewritten.bytes, odsType).get('content.xml') ?? '';
    expect(xml).toContain('o:string-value="cached"');
    expect(xml).not.toMatch(/WEBSERVICE|formula|table-source|attacker|named-range|secret/u);
  });
  it('rejects a redefined prefix and a switched default namespace', () => {
    expect(() =>
      rewriteWorkbook(
        xlsx({
          'xl/worksheets/sheet1.xml': `<x:worksheet xmlns:x="${spreadsheetNamespace}"><x:sheetData xmlns:x="urn:attacker"><x:row/></x:sheetData></x:worksheet>`,
        }),
        xlsxType,
      ),
    ).toThrow('WORKBOOK_XML_NAMESPACE_REJECTED');
    expect(() =>
      rewriteWorkbook(
        xlsx({
          'xl/worksheets/sheet1.xml': `<worksheet xmlns="${spreadsheetNamespace}"><sheetData xmlns="urn:attacker"><row/></sheetData></worksheet>`,
        }),
        xlsxType,
      ),
    ).toThrow('WORKBOOK_XML_NAMESPACE_REJECTED');
  });
  it('accepts legal numeric character references and decodes them', () => {
    const rewritten = rewriteWorkbook(
      xlsx({
        'xl/workbook.xml': `<workbook xmlns="${spreadsheetNamespace}" xmlns:r="${officeRelationshipNamespace}"><sheets><sheet name="Line 1&#10;Line 2&#xA;&#x1F600;" sheetId="1" state="hidden" r:id="rId2"/></sheets></workbook>`,
        'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${relationshipNamespace}"><Relationship Id="rId2" Type="${officeRelationshipNamespace}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`,
        'xl/worksheets/sheet1.xml': `<worksheet xmlns="${spreadsheetNamespace}"><sheetData><row><c r="A1"><v>Line 1&#10;Line 2&#xA;&#x1F600;</v></c></row></sheetData></worksheet>`,
      }),
      xlsxType,
    );
    expect(rewritten.hiddenSheets).toEqual(['Line 1\nLine 2\n😀']);
    expect(content(rewritten.bytes, xlsxType).get('xl/worksheets/sheet1.xml')).toContain(
      'Line 1&#10;Line 2&#xA;&#x1F600;',
    );
  });
  it.each(['&#xD800;', '&#x110000;', '&#0;', '&#'])(
    'rejects illegal numeric reference %s',
    (reference) => {
      expect(() =>
        rewriteWorkbook(
          xlsx({
            'xl/worksheets/sheet1.xml': `<worksheet xmlns="${spreadsheetNamespace}">${reference}</worksheet>`,
          }),
          xlsxType,
        ),
      ).toThrow('WORKBOOK_XML_ENTITY_REJECTED');
    },
  );
  it('removes accepted dimension metadata instead of passing declared extents to conversion', () => {
    const rewritten = rewriteWorkbook(
      xlsx({
        'xl/worksheets/sheet1.xml': `<worksheet xmlns="${spreadsheetNamespace}"><dimension ref="A1:XFD1048576"/><sheetData><row><c r="A1"><v>1</v></c></row></sheetData></worksheet>`,
      }),
      xlsxType,
    );
    const worksheet = content(rewritten.bytes, xlsxType).get('xl/worksheets/sheet1.xml') ?? '';
    expect(worksheet).toContain('<c r="A1"><v>1</v></c>');
    expect(worksheet).not.toContain('dimension');
  });
  it('rejects merged ranges that exceed the worksheet extent bound', () => {
    expect(() =>
      rewriteWorkbook(
        xlsx({
          'xl/worksheets/sheet1.xml': `<worksheet xmlns="${spreadsheetNamespace}"><sheetData><row><c r="A1"><v>1</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="A1:XFD1048576"/></mergeCells></worksheet>`,
        }),
        xlsxType,
      ),
    ).toThrow('WORKBOOK_RESOURCE_REJECTED');
  });
  it('removes nonessential range-bearing worksheet metadata before conversion', () => {
    const rewritten = rewriteWorkbook(
      xlsx({
        'xl/worksheets/sheet1.xml': `<worksheet xmlns="${spreadsheetNamespace}"><sheetViews><sheetView><pane topLeftCell="XFD1048576"/><selection activeCell="XFD1048576" sqref="XFD1048576"/></sheetView></sheetViews><sheetData><row r="1" spans="1:16384"><c r="A1"><v>1</v></c></row></sheetData><autoFilter ref="A1:XFD1048576"/><conditionalFormatting sqref="A1:XFD1048576"><cfRule type="expression"><formula>TRUE</formula></cfRule></conditionalFormatting><dataValidations><dataValidation sqref="A1:XFD1048576"/></dataValidations><tableParts count="1"><tablePart/></tableParts></worksheet>`,
      }),
      xlsxType,
    );
    const worksheet = content(rewritten.bytes, xlsxType).get('xl/worksheets/sheet1.xml') ?? '';
    expect(worksheet).toContain('<c r="A1"><v>1</v></c>');
    expect(worksheet).not.toMatch(
      /sheetViews|pane|selection|spans|autoFilter|conditionalFormatting|dataValidations|tableParts/u,
    );
  });
  it('sanitizes every relationship-referenced worksheet regardless of package path', () => {
    const relocated = xlsx({
      'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${relationshipNamespace}"><Relationship Id="rId1" Type="${officeRelationshipNamespace}/worksheet" Target="evil.xml"/><Relationship Id="rId2" Type="${officeRelationshipNamespace}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${officeRelationshipNamespace}/worksheet" Target="worksheets/sheet3.xml"/></Relationships>`,
      'xl/evil.xml': `<worksheet xmlns="${spreadsheetNamespace}"><sheetData><row><c r="A1"><f>WEBSERVICE(&quot;https://attacker.invalid&quot;)</f><v>cached</v></c></row></sheetData></worksheet>`,
    });
    const entries = content(rewriteWorkbook(relocated, xlsxType).bytes, xlsxType);
    expect(entries.get('xl/evil.xml')).toContain('<v>cached</v>');
    expect(entries.get('xl/evil.xml')).not.toMatch(/WEBSERVICE|<f>/u);

    /*
     * A `..` target that stays inside the package is legal: from xl/workbook.xml,
     * `../root-sheet.xml` resolves to root-sheet.xml. It must be accepted AND
     * sanitized. Banning every `..` segment rejected valid producer output; only
     * a target escaping the package root may be refused.
     */
    const packageContained = xlsx({
      'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${relationshipNamespace}"><Relationship Id="rId1" Type="${officeRelationshipNamespace}/worksheet" Target="../root-sheet.xml"/><Relationship Id="rId2" Type="${officeRelationshipNamespace}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${officeRelationshipNamespace}/worksheet" Target="worksheets/sheet3.xml"/></Relationships>`,
      'root-sheet.xml': `<worksheet xmlns="${spreadsheetNamespace}"><sheetData><row><c r="A1"><f>WEBSERVICE(&quot;https://attacker.invalid&quot;)</f><v>cached</v></c></row></sheetData></worksheet>`,
    });
    const rootEntries = content(rewriteWorkbook(packageContained, xlsxType).bytes, xlsxType);
    expect(rootEntries.get('root-sheet.xml')).toContain('<v>cached</v>');
    expect(rootEntries.get('root-sheet.xml')).not.toMatch(/WEBSERVICE|<f>/u);

    /*
     * A target escaping the package must be refused by the escape check itself,
     * not incidentally by the dangling-part check. Supplying the escaped part
     * ('etc/x.xml', where '../../etc/x.xml' would land if popping past the root
     * were allowed) removes that second line of defence, so this asserts the
     * escape guard is load-bearing.
     */
    expect(() =>
      rewriteWorkbook(
        xlsx({
          'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${relationshipNamespace}"><Relationship Id="rId1" Type="${officeRelationshipNamespace}/worksheet" Target="../../etc/x.xml"/><Relationship Id="rId2" Type="${officeRelationshipNamespace}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${officeRelationshipNamespace}/worksheet" Target="worksheets/sheet3.xml"/></Relationships>`,
          'etc/x.xml': `<worksheet xmlns="${spreadsheetNamespace}"><sheetData/></worksheet>`,
        }),
        xlsxType,
      ),
    ).toThrow('WORKBOOK_STRUCTURE_REJECTED');

    expect(() =>
      rewriteWorkbook(
        xlsx({
          'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${relationshipNamespace}"><Relationship Id="rId1" Type="${officeRelationshipNamespace}/worksheet" Target="evil.xml"/><Relationship Id="rId2" Type="${officeRelationshipNamespace}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${officeRelationshipNamespace}/worksheet" Target="worksheets/sheet3.xml"/></Relationships>`,
          'xl/evil.xml': `<worksheet xmlns="${spreadsheetNamespace}"><sheetData><row><c r="XFD1048576"><f>WEBSERVICE(&quot;https://attacker.invalid&quot;)</f><v>cached</v></c></row></sheetData></worksheet>`,
        }),
        xlsxType,
      ),
    ).toThrow('WORKBOOK_RESOURCE_REJECTED');
  });
  it.each([
    `<Relationships xmlns="${relationshipNamespace}"><Relationship Id="rId1" Type="${officeRelationshipNamespace}/worksheet" Target="../../etc/x.xml"/><Relationship Id="rId2" Type="${officeRelationshipNamespace}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${officeRelationshipNamespace}/worksheet" Target="worksheets/sheet3.xml"/></Relationships>`,
    `<Relationships xmlns="${relationshipNamespace}"><Relationship Id="rId1" Type="${officeRelationshipNamespace}/worksheet" Target="/xl/evil.xml"/><Relationship Id="rId2" Type="${officeRelationshipNamespace}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${officeRelationshipNamespace}/worksheet" Target="worksheets/sheet3.xml"/></Relationships>`,
    `<Relationships xmlns="${relationshipNamespace}"><Relationship Id="rId1" Type="${officeRelationshipNamespace}/worksheet" Target="missing.xml"/><Relationship Id="rId2" Type="${officeRelationshipNamespace}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${officeRelationshipNamespace}/worksheet" Target="worksheets/sheet3.xml"/></Relationships>`,
    `<Relationships xmlns="${relationshipNamespace}"><Relationship Id="rId2" Type="${officeRelationshipNamespace}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${officeRelationshipNamespace}/worksheet" Target="worksheets/sheet3.xml"/></Relationships>`,
    `<Relationships xmlns="${relationshipNamespace}"><Relationship Id="rId1" Type="${officeRelationshipNamespace}/worksheet"/><Relationship Id="rId2" Type="${officeRelationshipNamespace}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${officeRelationshipNamespace}/worksheet" Target="worksheets/sheet3.xml"/></Relationships>`,
    `<Relationships xmlns="${relationshipNamespace}"><Relationship Id="rId1" Type="${officeRelationshipNamespace}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId1" Type="${officeRelationshipNamespace}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${officeRelationshipNamespace}/worksheet" Target="worksheets/sheet3.xml"/></Relationships>`,
    `<Relationships xmlns="${relationshipNamespace}"><Relationship Id="rId1" Type="unexpected" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${officeRelationshipNamespace}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${officeRelationshipNamespace}/worksheet" Target="worksheets/sheet3.xml"/></Relationships>`,
    `<Relationships xmlns="${relationshipNamespace}"><Relationship Id="rId1" Type="${officeRelationshipNamespace}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${officeRelationshipNamespace}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${officeRelationshipNamespace}/worksheet" Target="worksheets/sheet3.xml"/><Relationship Id="rId4" Type="${officeRelationshipNamespace}/worksheet" Target="evil.xml"/></Relationships>`,
  ])('fails closed on an invalid workbook worksheet graph', (relationships) => {
    expect(() =>
      rewriteWorkbook(xlsx({ 'xl/_rels/workbook.xml.rels': relationships }), xlsxType),
    ).toThrow('WORKBOOK_STRUCTURE_REJECTED');
  });
  it('strips custom sheet views wholesale', () => {
    const rewritten = rewriteWorkbook(
      xlsx({
        'xl/worksheets/sheet1.xml': `<worksheet xmlns="${spreadsheetNamespace}"><customSheetViews><customSheetView><selection activeCell="XFD1048576" sqref="A1:XFD1048576"/></customSheetView></customSheetViews><sheetData><row><c r="A1"><v>1</v></c></row></sheetData></worksheet>`,
      }),
      xlsxType,
    );
    const worksheet = content(rewritten.bytes, xlsxType).get('xl/worksheets/sheet1.xml') ?? '';
    expect(worksheet).toContain('<c r="A1"><v>1</v></c>');
    expect(worksheet).not.toMatch(/customSheetViews|customSheetView|selection|sqref/u);
  });
  it('strips unknown future elements carrying range-bearing attributes', () => {
    const rewritten = rewriteWorkbook(
      xlsx({
        'xl/worksheets/sheet1.xml': `<worksheet xmlns="${spreadsheetNamespace}"><sheetData><row><c r="A1"><v>1</v></c></row></sheetData><futureRange sqref="A1:XFD1048576"><futureChild>unsafe</futureChild></futureRange></worksheet>`,
      }),
      xlsxType,
    );
    const worksheet = content(rewritten.bytes, xlsxType).get('xl/worksheets/sheet1.xml') ?? '';
    expect(worksheet).toContain('<c r="A1"><v>1</v></c>');
    expect(worksheet).not.toMatch(/futureRange|futureChild|sqref/u);
  });
  it('keeps only exact OOXML HTTPS hyperlink relationship types', () => {
    const rewritten = rewriteWorkbook(
      xlsx({
        'xl/worksheets/_rels/sheet1.xml.rels': `<Relationships xmlns="${relationshipNamespace}"><Relationship Id="transitional" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" TargetMode="External" Target="https://example.com/transitional"/><Relationship Id="strict" Type="http://purl.oclc.org/ooxml/officeDocument/relationships/hyperlink" TargetMode="External" Target="https://example.com/strict"/><Relationship Id="lookalike" Type="https://attacker.invalid/hyperlink" TargetMode="External" Target="https://example.com/lookalike"/><Relationship Id="image" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" TargetMode="External" Target="https://example.com/image"/></Relationships>`,
      }),
      xlsxType,
    );
    const relationships =
      content(rewritten.bytes, xlsxType).get('xl/worksheets/_rels/sheet1.xml.rels') ?? '';
    expect(relationships).toContain('https://example.com/transitional');
    expect(relationships).toContain('https://example.com/strict');
    expect(relationships).not.toMatch(/lookalike|example\.com\/image/u);
  });
  it('rejects sparse worksheet extents before conversion', () => {
    expect(() =>
      rewriteWorkbook(
        xlsx({
          'xl/worksheets/sheet1.xml': `<worksheet xmlns="${spreadsheetNamespace}"><dimension ref="A1:XFD1048576"/><sheetData><row r="1048576"><c r="XFD1048576"><v>1</v></c></row></sheetData></worksheet>`,
        }),
        xlsxType,
      ),
    ).toThrow('WORKBOOK_RESOURCE_REJECTED');
  });
  it('permits HTTPS only on ODS user hyperlinks, never external data constructs', () => {
    const rewritten = rewriteWorkbook(
      ods({
        'content.xml': `<office:document-content ${odfNamespaces}><office:body><office:spreadsheet><table:table table:name="Links"><table:table-source xlink:href="https://attacker.invalid/data"/><table:table-row><table:table-cell><text:p><text:a xlink:href="https://example.com/">safe</text:a></text:p><draw:image xlink:href="https://attacker.invalid/image"/></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>`,
      }),
      odsType,
    );
    const xml = content(rewritten.bytes, odsType).get('content.xml') ?? '';
    expect(xml).toContain('xlink:href="https://example.com/"');
    expect(xml).not.toMatch(/table-source|attacker\.invalid/u);
  });
  it('rejects repeated-cell expansion before conversion', () => {
    expect(() =>
      rewriteWorkbook(
        ods({
          'content.xml': `<office:document-content ${odfNamespaces}><table:table table:name="Huge"><table:table-row><table:table-cell table:number-columns-repeated="1000000000"/></table:table-row></table:table></office:document-content>`,
        }),
        odsType,
      ),
    ).toThrow('WORKBOOK_RESOURCE_REJECTED');
  });
  it('runs genuine rewriting in the credential-free sandbox before the fixture conversion result', async () => {
    const program = sandboxProgram(
      process.execPath,
      [workbookFixture],
      [workbookFixture, workbookRewriter, sourceValidation, resourcePolicy],
    );
    const result = await processSource({
      mediaType: xlsxType,
      bytes: xlsx(),
      programs: { pdf: program, office: program, image: program, text: program },
      limits: {
        timeoutMilliseconds: 5_000,
        maximumOutputBytes: 1024 * 1024,
        maximumInputBytes: 1024 * 1024,
        maximumTemporaryBytes: 1024 * 1024,
      },
    });
    expect(result.hiddenSheets).toEqual(['Hidden', 'Very hidden']);
    expect(result.pages[0]?.accessibleLabel).toBe('Workbook page 1');
  });
  it('relaunches soffice.bin once after first-start profile initialisation', async () => {
    const result = await runWorkbookAdapter('restart');
    expect(result).toMatchObject({ pages: [{ mediaType: 'image/png', width: 1, height: 1 }] });
  });
  it('reports an office failure when soffice.bin exits cleanly without a PDF', async () => {
    expect(await runWorkbookAdapter('no-pdf')).toEqual({ processorError: 'office' });
  });
  it('uses only real LibreOffice 25.2 conversion options and a per-conversion profile', () => {
    expect(
      libreOfficeArguments('/scratch/profile', '/scratch/source.xlsx', '/scratch'),
    ).toEqual([
      '--headless',
      '-env:UserInstallation=file:///scratch/profile',
      '--convert-to',
      'pdf:calc_pdf_Export',
      '--outdir',
      '/scratch',
      '/scratch/source.xlsx',
    ]);
  });
});
