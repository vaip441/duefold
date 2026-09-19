import { Buffer } from 'node:buffer';
import { readValidatedOfficeContainer, type SourceMediaType } from '../source-validation.ts';

const MAX_SHEETS = 1_000;
const MAX_CELLS = 1_000_000;
const MAX_STRING_LENGTH = 32_768;
const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;
const XML_NAME = '[A-Za-z_][A-Za-z0-9_.:-]*';
const ATTRIBUTE = new RegExp(`\\s+(${XML_NAME})\\s*=\\s*("[^"]*"|'[^']*')`, 'gu');
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';
const SPREADSHEET_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  'http://purl.oclc.org/ooxml/spreadsheetml/main',
]);
const PACKAGE_RELATIONSHIP_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/package/2006/relationships',
  'http://purl.oclc.org/ooxml/package/relationships',
]);
const OFFICE_RELATIONSHIP_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships',
]);
const CONTENT_TYPES_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/package/2006/content-types',
]);
const MARKUP_COMPATIBILITY_NAMESPACE =
  'http://schemas.openxmlformats.org/markup-compatibility/2006';
const OOXML_EXTENSION_METADATA_NAMESPACES = new Set([
  'http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac',
  'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main',
  'http://schemas.microsoft.com/office/spreadsheetml/2010/11/main',
  'http://schemas.microsoft.com/office/spreadsheetml/2014/revision',
  'http://schemas.microsoft.com/office/spreadsheetml/2015/revision2',
  'http://schemas.microsoft.com/office/spreadsheetml/2016/revision3',
  'http://schemas.microsoft.com/office/spreadsheetml/2016/revision6',
  'http://schemas.microsoft.com/office/spreadsheetml/2016/revision10',
  'http://schemas.microsoft.com/office/spreadsheetml/2017/revision16',
]);
const OOXML_PROPERTY_METADATA_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties',
  'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties',
  'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes',
]);
const OOXML_DISCARDED_ATTRIBUTE_NAMESPACES = new Set([
  MARKUP_COMPATIBILITY_NAMESPACE,
  ...OOXML_EXTENSION_METADATA_NAMESPACES,
]);
const OOXML_DISCARDED_ELEMENT_NAMESPACES = new Set([
  MARKUP_COMPATIBILITY_NAMESPACE,
  ...OOXML_EXTENSION_METADATA_NAMESPACES,
]);
const HYPERLINK_RELATIONSHIP_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/hyperlink',
]);
const WORKSHEET_RELATIONSHIP_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/worksheet',
]);
const ODF = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
  xlink: 'http://www.w3.org/1999/xlink',
  manifest: 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0',
} as const;
const KNOWN_ELEMENT_NAMESPACES = new Set([
  ...SPREADSHEET_NAMESPACES,
  ...PACKAGE_RELATIONSHIP_NAMESPACES,
  ...CONTENT_TYPES_NAMESPACES,
  ...Object.values(ODF),
  'http://schemas.openxmlformats.org/drawingml/2006/main',
  'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing',
  'http://schemas.openxmlformats.org/package/2006/metadata/core-properties',
  ...OOXML_PROPERTY_METADATA_NAMESPACES,
  MARKUP_COMPATIBILITY_NAMESPACE,
  ...OOXML_EXTENSION_METADATA_NAMESPACES,
  'http://purl.org/dc/elements/1.1/',
  'http://purl.org/dc/terms/',
  'http://purl.org/dc/dcmitype/',
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  'http://docs.oasis-open.org/ns/office/1.2/meta/odf#',
  'http://www.w3.org/2000/01/rdf-schema#',
  'http://www.w3.org/2002/07/owl#',
  'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  'urn:oasis:names:tc:opendocument:xmlns:fo-compatible:1.0',
  'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
  'urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0',
  'urn:oasis:names:tc:opendocument:xmlns:meta:1.0',
  'urn:oasis:names:tc:opendocument:xmlns:config:1.0',
  'urn:oasis:names:tc:opendocument:xmlns:presentation:1.0',
]);
const KNOWN_ATTRIBUTE_NAMESPACES = new Set([
  ...KNOWN_ELEMENT_NAMESPACES,
  ...OFFICE_RELATIONSHIP_NAMESPACES,
  XML_NAMESPACE,
]);
const CRC32_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1)
    crc = (crc & 1) === 0 ? crc >>> 1 : 0xedb88320 ^ (crc >>> 1);
  return crc >>> 0;
});

export interface RewrittenWorkbook {
  readonly bytes: Uint8Array;
  readonly hiddenSheets: readonly string[];
}
interface XmlAttribute {
  readonly name: string;
  readonly namespaceUri: string;
  readonly localName: string;
  readonly value: string;
}
interface XmlTag {
  readonly name: string;
  readonly namespaceUri: string;
  readonly localName: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
  readonly attributes: readonly XmlAttribute[];
}
interface ZipOutputEntry {
  readonly name: string;
  readonly content: Uint8Array;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of bytes) crc = (CRC32_TABLE[(crc ^ value) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function xmlText(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('WORKBOOK_XML_REJECTED');
  }
  // Numeric character references are inert XML scalar encodings, not general
  // entities. Validate and accept legal XML characters while rejecting DTDs,
  // declarations, parameter entities, and every non-predefined named entity.
  if (/<!DOCTYPE\b|<!ENTITY\b|%[A-Za-z_:]/iu.test(text))
    throw new Error('WORKBOOK_XML_ENTITY_REJECTED');
  for (let cursor = text.indexOf('&'); cursor >= 0; cursor = text.indexOf('&', cursor + 1)) {
    const end = text.indexOf(';', cursor + 1);
    if (end < 0) throw new Error('WORKBOOK_XML_ENTITY_REJECTED');
    const reference = text.slice(cursor + 1, end);
    if (/^(?:amp|lt|gt|quot|apos)$/u.test(reference)) continue;
    const numeric = /^#([0-9]+)$/u.exec(reference) ?? /^#x([0-9A-Fa-f]+)$/u.exec(reference);
    const digits = numeric?.[1];
    if (digits === undefined) throw new Error('WORKBOOK_XML_ENTITY_REJECTED');
    const codePoint = Number.parseInt(digits, reference.startsWith('#x') ? 16 : 10);
    if (!isLegalXmlCharacter(codePoint)) throw new Error('WORKBOOK_XML_ENTITY_REJECTED');
  }
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || !isLegalXmlCharacter(codePoint))
      throw new Error('WORKBOOK_XML_REJECTED');
  }
  if (text.length > MAX_OUTPUT_BYTES) throw new Error('WORKBOOK_RESOURCE_REJECTED');
  return text;
}
function isLegalXmlCharacter(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    (value === 0x09 ||
      value === 0x0a ||
      value === 0x0d ||
      (value >= 0x20 && value <= 0xd7ff) ||
      (value >= 0xe000 && value <= 0xfffd) ||
      (value >= 0x10000 && value <= 0x10ffff))
  );
}
function decodeXml(value: string): string {
  return value
    .replace(
      /&#([0-9]+);|&#x([0-9A-Fa-f]+);/gu,
      (_match, decimal: string | undefined, hex: string | undefined) =>
        String.fromCodePoint(
          Number.parseInt(decimal ?? hex ?? '', decimal === undefined ? 16 : 10),
        ),
    )
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}
interface RawXmlTag {
  readonly name: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
  readonly attributes: readonly { readonly name: string; readonly value: string }[];
}
function parseRawTag(raw: string): RawXmlTag | undefined {
  if (raw.startsWith('<?')) {
    if (
      !/^<\?xml\s+version\s*=\s*(?:"1\.[01]"|'1\.[01]')\s*(?:encoding\s*=\s*(?:"UTF-8"|'UTF-8'))?\s*\?>$/iu.test(
        raw,
      )
    )
      throw new Error('WORKBOOK_XML_REJECTED');
    return undefined;
  }
  if (raw.startsWith('<!--') || raw.startsWith('<![CDATA[')) return undefined;
  const closing = /^<\s*\//u.test(raw);
  const match = new RegExp(`^<\\s*${closing ? '/' : ''}\\s*(${XML_NAME})`, 'u').exec(raw);
  const name = match?.[1];
  if (name === undefined || match === null) throw new Error('WORKBOOK_XML_REJECTED');
  const attributes: { name: string; value: string }[] = [];
  const names = new Set<string>();
  if (!closing) {
    ATTRIBUTE.lastIndex = 0;
    for (const item of raw.matchAll(ATTRIBUTE)) {
      const attributeName = item[1];
      const quoted = item[2];
      if (attributeName === undefined || quoted === undefined || names.has(attributeName))
        throw new Error('WORKBOOK_XML_REJECTED');
      names.add(attributeName);
      const value = decodeXml(quoted.slice(1, -1));
      if (value.length > MAX_STRING_LENGTH) throw new Error('WORKBOOK_RESOURCE_REJECTED');
      attributes.push({ name: attributeName, value });
    }
    const withoutAttributes = raw
      .slice(match[0].length)
      .replace(ATTRIBUTE, '')
      .replace(/\/?\s*>$/u, '');
    if (!/^\s*$/u.test(withoutAttributes)) throw new Error('WORKBOOK_XML_REJECTED');
  } else if (!new RegExp(`^<\\s*\\/\\s*${regularExpressionEscape(name)}\\s*>$`, 'u').test(raw))
    throw new Error('WORKBOOK_XML_REJECTED');
  return { name, closing, selfClosing: /\/\s*>$/u.test(raw), attributes };
}
function splitQName(name: string): { readonly prefix: string; readonly localName: string } {
  const parts = name.split(':');
  if (parts.length > 2 || parts[0] === '' || parts.at(-1) === '')
    throw new Error('WORKBOOK_XML_REJECTED');
  return parts.length === 1
    ? { prefix: '', localName: parts[0] ?? '' }
    : { prefix: parts[0] ?? '', localName: parts[1] ?? '' };
}
function resolveNamespace(name: string, namespaces: ReadonlyMap<string, string>): string {
  const { prefix } = splitQName(name);
  const namespaceUri = namespaces.get(prefix);
  if (namespaceUri === undefined) throw new Error('WORKBOOK_XML_NAMESPACE_REJECTED');
  return namespaceUri;
}
function tokens(xml: string): readonly { readonly raw: string; readonly tag?: XmlTag }[] {
  const values: { raw: string; tag?: XmlTag }[] = [];
  let cursor = 0;
  const elementStack: string[] = [];
  const namespaceStack: ReadonlyMap<string, string>[] = [
    new Map([
      ['', ''],
      ['xml', XML_NAMESPACE],
      ['xmlns', XMLNS_NAMESPACE],
    ]),
  ];
  while (cursor < xml.length) {
    const start = xml.indexOf('<', cursor);
    if (start < 0) {
      const raw = xml.slice(cursor);
      if (decodeXml(raw).length > MAX_STRING_LENGTH)
        throw new Error('WORKBOOK_RESOURCE_REJECTED');
      values.push({ raw });
      break;
    }
    if (start > cursor) {
      const raw = xml.slice(cursor, start);
      if (decodeXml(raw).length > MAX_STRING_LENGTH)
        throw new Error('WORKBOOK_RESOURCE_REJECTED');
      values.push({ raw });
    }
    let end: number;
    if (xml.startsWith('<!--', start)) {
      end = xml.indexOf('-->', start + 4);
      if (end < 0 || xml.slice(start + 4, end).includes('--'))
        throw new Error('WORKBOOK_XML_REJECTED');
      end += 3;
    } else if (xml.startsWith('<![CDATA[', start)) {
      end = xml.indexOf(']]>', start + 9);
      if (end < 0 || end - start - 9 > MAX_STRING_LENGTH)
        throw new Error('WORKBOOK_XML_REJECTED');
      end += 3;
    } else {
      let quote = '';
      end = start + 1;
      for (; end < xml.length; end += 1) {
        const character = xml[end] ?? '';
        if (quote === '') {
          if (character === '"' || character === "'") quote = character;
          else if (character === '>') {
            end += 1;
            break;
          }
        } else if (character === quote) quote = '';
      }
      if (end > xml.length || xml[end - 1] !== '>') throw new Error('WORKBOOK_XML_REJECTED');
    }
    const raw = xml.slice(start, end);
    const parsed = parseRawTag(raw);
    if (parsed === undefined) values.push({ raw });
    else {
      const parentNamespaces = namespaceStack.at(-1);
      if (parentNamespaces === undefined) throw new Error('WORKBOOK_XML_REJECTED');
      const namespaces = new Map(parentNamespaces);
      if (!parsed.closing) {
        for (const item of parsed.attributes) {
          if (item.name === 'xmlns') namespaces.set('', item.value);
          else if (item.name.startsWith('xmlns:')) {
            const { localName } = splitQName(item.name);
            if (localName === 'xml' || localName === 'xmlns' || item.value === '')
              throw new Error('WORKBOOK_XML_NAMESPACE_REJECTED');
            namespaces.set(localName, item.value);
          }
        }
      }
      const namespaceUri = resolveNamespace(parsed.name, namespaces);
      if (namespaceUri === '' || !KNOWN_ELEMENT_NAMESPACES.has(namespaceUri))
        throw new Error('WORKBOOK_XML_NAMESPACE_REJECTED');
      const { localName } = splitQName(parsed.name);
      const attributes: XmlAttribute[] = [];
      for (const item of parsed.attributes) {
        const qname = splitQName(item.name);
        const attributeNamespace =
          item.name === 'xmlns' || qname.prefix === 'xmlns'
            ? XMLNS_NAMESPACE
            : qname.prefix === ''
              ? ''
              : resolveNamespace(item.name, namespaces);
        if (
          attributeNamespace !== '' &&
          attributeNamespace !== XMLNS_NAMESPACE &&
          !KNOWN_ATTRIBUTE_NAMESPACES.has(attributeNamespace)
        )
          throw new Error('WORKBOOK_XML_NAMESPACE_REJECTED');
        attributes.push({
          name: item.name,
          namespaceUri: attributeNamespace,
          localName: qname.localName,
          value: item.value,
        });
      }
      const tag: XmlTag = {
        name: parsed.name,
        namespaceUri,
        localName,
        closing: parsed.closing,
        selfClosing: parsed.selfClosing,
        attributes,
      };
      if (parsed.closing) {
        if (elementStack.pop() !== parsed.name) throw new Error('WORKBOOK_XML_REJECTED');
        namespaceStack.pop();
      } else if (!parsed.selfClosing) {
        elementStack.push(parsed.name);
        namespaceStack.push(namespaces);
      }
      values.push({ raw, tag });
    }
    cursor = end;
  }
  if (elementStack.length !== 0 || namespaceStack.length !== 1)
    throw new Error('WORKBOOK_XML_REJECTED');
  return values;
}
function isElement(
  tag: XmlTag | undefined,
  namespaces: ReadonlySet<string>,
  localName: string,
): tag is XmlTag {
  return tag !== undefined && namespaces.has(tag.namespaceUri) && tag.localName === localName;
}
function attribute(tag: XmlTag, localName: string, namespaceUri = ''): string | undefined {
  return tag.attributes.find(
    (item) => item.namespaceUri === namespaceUri && item.localName === localName,
  )?.value;
}
function attributeIn(
  tag: XmlTag,
  localName: string,
  namespaces: ReadonlySet<string>,
): string | undefined {
  return tag.attributes.find(
    (item) => namespaces.has(item.namespaceUri) && item.localName === localName,
  )?.value;
}
function regularExpressionEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
function removeAttribute(
  raw: string,
  tag: XmlTag,
  localName: string,
  namespaceUri: string,
): string {
  const lexicalName = tag.attributes.find(
    (item) => item.namespaceUri === namespaceUri && item.localName === localName,
  )?.name;
  if (lexicalName === undefined) return raw;
  return raw.replace(
    new RegExp(`\\s+${regularExpressionEscape(lexicalName)}\\s*=\\s*(?:"[^"]*"|'[^']*')`, 'gu'),
    '',
  );
}
interface ElementSelector {
  readonly namespaces: ReadonlySet<string>;
  readonly localName?: string;
}
function stripElements(xml: string, selectors: readonly ElementSelector[]): string {
  const values = tokens(xml);
  let depth = 0;
  return values
    .map(({ raw, tag }) => {
      if (tag === undefined) return depth === 0 ? raw : '';
      if (depth > 0) {
        if (!tag.closing && !tag.selfClosing) depth += 1;
        else if (tag.closing) depth -= 1;
        return '';
      }
      if (
        !tag.closing &&
        selectors.some(
          (selector) =>
            selector.namespaces.has(tag.namespaceUri) &&
            (selector.localName === undefined || tag.localName === selector.localName),
        )
      ) {
        if (!tag.selfClosing) depth = 1;
        return '';
      }
      return raw;
    })
    .join('');
}
function stripAttributesInNamespaces(xml: string, namespaces: ReadonlySet<string>): string {
  return tokens(xml)
    .map(({ raw, tag }) => {
      if (tag === undefined || tag.closing) return raw;
      return tag.attributes
        .filter((item) => namespaces.has(item.namespaceUri))
        .reduce(
          (sanitized, item) =>
            removeAttribute(sanitized, tag, item.localName, item.namespaceUri),
          raw,
        );
    })
    .join('');
}
function sanitizeOoxmlMetadata(xml: string): string {
  const withoutElements = stripElements(xml, [
    { namespaces: OOXML_DISCARDED_ELEMENT_NAMESPACES },
  ]);
  return stripAttributesInNamespaces(withoutElements, OOXML_DISCARDED_ATTRIBUTE_NAMESPACES);
}
function relationshipTargetAllowed(tag: XmlTag): boolean {
  if (attribute(tag, 'TargetMode') !== 'External') return true;
  if (!HYPERLINK_RELATIONSHIP_TYPES.has(attribute(tag, 'Type') ?? '')) return false;
  const target = attribute(tag, 'Target');
  if (target === undefined || target.length > 2048) return false;
  try {
    const url = new URL(target);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.hostname !== ''
    );
  } catch {
    return false;
  }
}
function sanitizeRelationships(xml: string, removedTargets: Set<string>): string {
  return tokens(xml)
    .map(({ raw, tag }) => {
      if (!isElement(tag, PACKAGE_RELATIONSHIP_NAMESPACES, 'Relationship') || tag.closing)
        return raw;
      const type = attribute(tag, 'Type') ?? '';
      const target = attribute(tag, 'Target') ?? '';
      if (
        !relationshipTargetAllowed(tag) ||
        /externalLink|oleObject|package|activeX|attachedToolbars|control|connections|queryTable|(?:\/|^)table$|drawing|comments|pivot|slicer|extended-properties|custom-properties/iu.test(
          type,
        )
      ) {
        removedTargets.add(target.replace(/^\.\.\//u, 'xl/'));
        return '';
      }
      return raw;
    })
    .join('');
}
function cellCoordinate(reference: string): { readonly column: number; readonly row: number } {
  const match = /^\$?([A-Z]{1,3})\$?([1-9][0-9]{0,6})$/u.exec(reference.toUpperCase());
  const letters = match?.[1];
  const rowText = match?.[2];
  if (letters === undefined || rowText === undefined)
    throw new Error('WORKBOOK_RESOURCE_REJECTED');
  let column = 0;
  for (const character of letters) column = column * 26 + character.charCodeAt(0) - 64;
  const row = Number(rowText);
  if (column > 16_384 || row > 1_048_576) throw new Error('WORKBOOK_RESOURCE_REJECTED');
  return { column, row };
}
function cellRange(reference: string): {
  readonly first: { readonly column: number; readonly row: number };
  readonly last: { readonly column: number; readonly row: number };
} {
  const parts = reference.split(':');
  if (parts.length < 1 || parts.length > 2) throw new Error('WORKBOOK_RESOURCE_REJECTED');
  const first = cellCoordinate(parts[0] ?? '');
  const last = cellCoordinate(parts[1] ?? parts[0] ?? '');
  if (first.column > last.column || first.row > last.row)
    throw new Error('WORKBOOK_RESOURCE_REJECTED');
  return { first, last };
}
const RANGE_ATTRIBUTE_NAMES = new Set(['ref', 'sqref', 'activecell', 'topleftcell', 'spans']);
function hasExtentPair(tag: XmlTag): boolean {
  const names = new Set(tag.attributes.map((item) => item.localName.toLowerCase()));
  return [...names].some(
    (name) => name.startsWith('min') && names.has(`max${name.slice('min'.length)}`),
  );
}
function hasRangeBearingAttribute(tag: XmlTag): boolean {
  return (
    tag.attributes.some((item) => RANGE_ATTRIBUTE_NAMES.has(item.localName.toLowerCase())) ||
    hasExtentPair(tag)
  );
}
function stripUnretainedWorksheetRanges(xml: string): string {
  let depth = 0;
  return tokens(xml)
    .map(({ raw, tag }) => {
      if (tag === undefined) return depth === 0 ? raw : '';
      if (depth > 0) {
        if (!tag.closing && !tag.selfClosing) depth += 1;
        else if (tag.closing) depth -= 1;
        return '';
      }
      if (tag.closing || !hasRangeBearingAttribute(tag)) return raw;
      const retainedReference =
        (isElement(tag, SPREADSHEET_NAMESPACES, 'mergeCell') ||
          isElement(tag, SPREADSHEET_NAMESPACES, 'hyperlink')) &&
        tag.attributes.filter((item) => RANGE_ATTRIBUTE_NAMES.has(item.localName.toLowerCase()))
          .length === 1 &&
        attribute(tag, 'ref') !== undefined &&
        !hasExtentPair(tag);
      if (retainedReference) return raw;
      if (!tag.selfClosing) depth = 1;
      return '';
    })
    .join('');
}
const REMOVED_WORKSHEET_RANGE_ELEMENTS = [
  'autoFilter',
  'conditionalFormatting',
  'cols',
  'dataConsolidate',
  'dataValidations',
  'ignoredErrors',
  'protectedRanges',
  'scenarios',
  'sheetViews',
  'customSheetViews',
  'sortState',
  'tableParts',
  'rowBreaks',
  'colBreaks',
] as const;
function sanitizeWorksheet(xml: string): { readonly xml: string; readonly cells: number } {
  let cells = 0;
  let maximumColumn = 0;
  let maximumRow = 0;
  const compatibilitySafe = sanitizeOoxmlMetadata(xml);
  const withoutDangerous = stripElements(compatibilitySafe, [
    ...[
      'oleObjects',
      'controls',
      'legacyDrawing',
      'legacyDrawingHF',
      'externalLinks',
      'drawing',
      'picture',
      'extLst',
      ...REMOVED_WORKSHEET_RANGE_ELEMENTS,
    ].map((localName) => ({ namespaces: SPREADSHEET_NAMESPACES, localName })),
    { namespaces: SPREADSHEET_NAMESPACES, localName: 'dimension' },
  ]);
  const withoutFormulas = stripElements(withoutDangerous, [
    { namespaces: SPREADSHEET_NAMESPACES, localName: 'f' },
  ]);
  const withoutRowMetadata = tokens(withoutFormulas)
    .map(({ raw, tag }) => {
      if (isElement(tag, SPREADSHEET_NAMESPACES, 'row') && !tag.closing) {
        const withoutRowReference = removeAttribute(raw, tag, 'r', '');
        return removeAttribute(withoutRowReference, tag, 'spans', '');
      }
      return raw;
    })
    .join('');
  const output = stripUnretainedWorksheetRanges(withoutRowMetadata);
  const includeInExtent = (coordinate: {
    readonly column: number;
    readonly row: number;
  }): void => {
    maximumColumn = Math.max(maximumColumn, coordinate.column);
    maximumRow = Math.max(maximumRow, coordinate.row);
    if (maximumColumn * maximumRow > MAX_CELLS) throw new Error('WORKBOOK_RESOURCE_REJECTED');
  };
  for (const { tag } of tokens(output)) {
    if (tag === undefined || tag.closing) continue;
    if (isElement(tag, SPREADSHEET_NAMESPACES, 'c')) {
      cells += 1;
      const reference = attribute(tag, 'r');
      if (reference === undefined) throw new Error('WORKBOOK_RESOURCE_REJECTED');
      includeInExtent(cellCoordinate(reference));
    } else if (
      isElement(tag, SPREADSHEET_NAMESPACES, 'mergeCell') ||
      isElement(tag, SPREADSHEET_NAMESPACES, 'hyperlink')
    ) {
      const reference = attribute(tag, 'ref');
      if (reference === undefined) throw new Error('WORKBOOK_RESOURCE_REJECTED');
      const range = cellRange(reference);
      includeInExtent(range.first);
      includeInExtent(range.last);
    }
  }
  return { xml: output, cells };
}
interface WorkbookRelationship {
  readonly type: string;
  readonly target: string;
  readonly targetMode?: string;
}
/*
 * Resolves a workbook relationship target against the workbook part's own
 * directory, per OPC part-name resolution.
 *
 * `..` cannot simply be banned: from `/xl/workbook.xml` a target of
 * `../evil.xml` resolves to `/evil.xml`, which is a legal package-contained
 * part that real producers emit. Only a target that escapes the package root,
 * is absolute, or hides traversal behind encoding may be rejected. The caller
 * deduplicates on the NORMALIZED result, so two spellings of one part cannot
 * appear to be two worksheets.
 */
function resolveWorkbookTarget(target: string): string {
  if (
    target === '' ||
    target.startsWith('/') ||
    target.includes('\\') ||
    target.includes('?') ||
    target.includes('#') ||
    target.includes('%') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target)
  )
    throw new Error('WORKBOOK_STRUCTURE_REJECTED');
  const segments = target.split('/');
  // Empty and single-dot segments are malformed in a relationship target.
  if (segments.some((segment) => segment === '' || segment === '.'))
    throw new Error('WORKBOOK_STRUCTURE_REJECTED');
  // Resolve against the workbook's directory, which is 'xl'.
  const resolved: string[] = ['xl'];
  for (const segment of segments) {
    if (segment === '..') {
      // Popping past the package root is an escape, not a valid part name.
      if (resolved.length === 0) throw new Error('WORKBOOK_STRUCTURE_REJECTED');
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  if (resolved.length === 0) throw new Error('WORKBOOK_STRUCTURE_REJECTED');
  return resolved.join('/');
}
function xlsx(entries: readonly ZipOutputEntry[]): RewrittenWorkbook {
  const map = new Map(entries.map((entry) => [entry.name, entry.content]));
  const workbookBytes = map.get('xl/workbook.xml');
  const relationshipsBytes = map.get('xl/_rels/workbook.xml.rels');
  if (workbookBytes === undefined || relationshipsBytes === undefined)
    throw new Error('WORKBOOK_STRUCTURE_REJECTED');
  const relationships = new Map<string, WorkbookRelationship>();
  for (const { tag } of tokens(xmlText(relationshipsBytes))) {
    if (!isElement(tag, PACKAGE_RELATIONSHIP_NAMESPACES, 'Relationship') || tag.closing)
      continue;
    const id = attribute(tag, 'Id');
    const type = attribute(tag, 'Type');
    const target = attribute(tag, 'Target');
    if (id === undefined || id === '' || type === undefined || target === undefined)
      throw new Error('WORKBOOK_STRUCTURE_REJECTED');
    if (relationships.has(id)) throw new Error('WORKBOOK_STRUCTURE_REJECTED');
    const targetMode = attribute(tag, 'TargetMode');
    relationships.set(id, {
      type,
      target,
      ...(targetMode === undefined ? {} : { targetMode }),
    });
  }
  const hiddenSheets: string[] = [];
  const removedParts = new Set<string>();
  const removedRelationshipIds = new Set<string>();
  const worksheetParts = new Set<string>();
  const worksheetRelationshipIds = new Set<string>();
  let sheetCount = 0;
  const workbookXml = stripElements(sanitizeOoxmlMetadata(xmlText(workbookBytes)), [
    { namespaces: SPREADSHEET_NAMESPACES, localName: 'definedNames' },
    { namespaces: SPREADSHEET_NAMESPACES, localName: 'extLst' },
  ]);
  const sanitizedWorkbook = tokens(workbookXml)
    .map(({ raw, tag }) => {
      if (!isElement(tag, SPREADSHEET_NAMESPACES, 'sheet') || tag.closing) return raw;
      sheetCount += 1;
      const relationId = attributeIn(tag, 'id', OFFICE_RELATIONSHIP_NAMESPACES);
      if (relationId === undefined || worksheetRelationshipIds.has(relationId))
        throw new Error('WORKBOOK_STRUCTURE_REJECTED');
      const relationship = relationships.get(relationId);
      if (
        relationship === undefined ||
        !WORKSHEET_RELATIONSHIP_TYPES.has(relationship.type) ||
        relationship.targetMode !== undefined
      )
        throw new Error('WORKBOOK_STRUCTURE_REJECTED');
      const target = resolveWorkbookTarget(relationship.target);
      if (worksheetParts.has(target) || !map.has(target))
        throw new Error('WORKBOOK_STRUCTURE_REJECTED');
      worksheetRelationshipIds.add(relationId);
      worksheetParts.add(target);
      const state = (attribute(tag, 'state') ?? 'visible').toLowerCase();
      if (state === 'visible') return raw;
      const name = attribute(tag, 'name') ?? `Sheet ${String(sheetCount)}`;
      hiddenSheets.push(name);
      removedRelationshipIds.add(relationId);
      removedParts.add(target);
      return '';
    })
    .join('');
  for (const [id, relationship] of relationships) {
    if (
      WORKSHEET_RELATIONSHIP_TYPES.has(relationship.type) &&
      !worksheetRelationshipIds.has(id)
    )
      throw new Error('WORKBOOK_STRUCTURE_REJECTED');
  }
  if (sheetCount > MAX_SHEETS) throw new Error('WORKBOOK_RESOURCE_REJECTED');
  const removedTargets = new Set<string>();
  let cellCount = 0;
  const output: ZipOutputEntry[] = [];
  const unsafePart = (name: string): boolean =>
    /^(?:xl\/(?:externalLinks|embeddings|activeX|queryTables|tables|drawings|comments|threadedComments|persons|pivotTables|pivotCache|slicers)\/|docProps\/(?:app|custom)\.xml$)/iu.test(
      name,
    ) ||
    name === 'xl/connections.xml' ||
    name === 'xl/calcChain.xml';
  for (const entry of entries) {
    if (removedParts.has(entry.name) || unsafePart(entry.name)) continue;
    let content = entry.content;
    if (entry.name === 'xl/workbook.xml') content = Buffer.from(sanitizedWorkbook);
    else if (entry.name.endsWith('.rels')) {
      let relationships = sanitizeRelationships(
        sanitizeOoxmlMetadata(xmlText(content)),
        removedTargets,
      );
      if (entry.name === 'xl/_rels/workbook.xml.rels')
        relationships = tokens(relationships)
          .map(({ raw, tag }) =>
            isElement(tag, PACKAGE_RELATIONSHIP_NAMESPACES, 'Relationship') &&
            !tag.closing &&
            removedRelationshipIds.has(attribute(tag, 'Id') ?? '')
              ? ''
              : raw,
          )
          .join('');
      content = Buffer.from(relationships);
    } else if (worksheetParts.has(entry.name)) {
      const sanitized = sanitizeWorksheet(xmlText(content));
      cellCount += sanitized.cells;
      content = Buffer.from(sanitized.xml);
    } else if (entry.name === '[Content_Types].xml') {
      content = Buffer.from(
        tokens(sanitizeOoxmlMetadata(xmlText(content)))
          .map(({ raw, tag }) => {
            if (!isElement(tag, CONTENT_TYPES_NAMESPACES, 'Override') || tag.closing)
              return raw;
            const part = (attribute(tag, 'PartName') ?? '').replace(/^\//u, '');
            return unsafePart(part) || removedParts.has(part) ? '' : raw;
          })
          .join(''),
      );
    } else if (entry.name.endsWith('.xml')) {
      const xml = sanitizeOoxmlMetadata(xmlText(content));
      tokens(xml);
      content = Buffer.from(xml);
    }
    if (!removedTargets.has(entry.name)) output.push({ name: entry.name, content });
    if (cellCount > MAX_CELLS) throw new Error('WORKBOOK_RESOURCE_REJECTED');
  }
  return { bytes: storedZip(output), hiddenSheets };
}
function repeatedCount(tag: XmlTag, localName: string): number {
  const value = attribute(tag, localName, ODF.table);
  if (value === undefined) return 1;
  if (!/^[1-9][0-9]{0,9}$/u.test(value)) throw new Error('WORKBOOK_RESOURCE_REJECTED');
  return Number(value);
}
function ods(entries: readonly ZipOutputEntry[]): RewrittenWorkbook {
  const hiddenSheets: string[] = [];
  let sheets = 0;
  let cells = 0;
  let rowCells = 0;
  let rowRepeat = 1;
  const output: ZipOutputEntry[] = [];
  for (const entry of entries) {
    if (/^(?:Basic|Scripts|ObjectReplacements|Objects)(?:\/|$)/iu.test(entry.name)) continue;
    if (!entry.name.endsWith('.xml') && !entry.name.endsWith('.rdf')) {
      output.push(entry);
      continue;
    }
    let xml = xmlText(entry.content);
    xml = stripElements(xml, [
      { namespaces: new Set([ODF.table]), localName: 'named-expressions' },
      { namespaces: new Set([ODF.table]), localName: 'dde-links' },
      { namespaces: new Set([ODF.table]), localName: 'table-source' },
      { namespaces: new Set([ODF.table]), localName: 'cell-range-source' },
      { namespaces: new Set([ODF.draw]), localName: 'object' },
      { namespaces: new Set([ODF.draw]), localName: 'object-ole' },
      { namespaces: new Set([ODF.office]), localName: 'scripts' },
    ]);
    if (entry.name === 'META-INF/manifest.xml')
      xml = tokens(xml)
        .map(({ raw, tag }) => {
          if (!isElement(tag, new Set([ODF.manifest]), 'file-entry') || tag.closing) return raw;
          const path = attribute(tag, 'full-path', ODF.manifest) ?? '';
          return /^(?:Basic|Scripts|ObjectReplacements|Objects)(?:\/|$)/iu.test(path)
            ? ''
            : raw;
        })
        .join('');
    let hiddenDepth = 0;
    xml = tokens(xml)
      .map(({ raw, tag }) => {
        if (tag === undefined) return hiddenDepth === 0 ? raw : '';
        if (hiddenDepth > 0) {
          if (!tag.closing && !tag.selfClosing) hiddenDepth += 1;
          else if (tag.closing) hiddenDepth -= 1;
          return '';
        }
        if (isElement(tag, new Set([ODF.table]), 'table') && !tag.closing) {
          sheets += 1;
          if ((attribute(tag, 'display', ODF.table) ?? 'true').toLowerCase() === 'false') {
            hiddenSheets.push(attribute(tag, 'name', ODF.table) ?? `Sheet ${String(sheets)}`);
            if (!tag.selfClosing) hiddenDepth = 1;
            return '';
          }
        }
        if (isElement(tag, new Set([ODF.table]), 'table-cell') && !tag.closing) {
          rowCells += repeatedCount(tag, 'number-columns-repeated');
          if (rowCells > MAX_CELLS) throw new Error('WORKBOOK_RESOURCE_REJECTED');
          return removeAttribute(raw, tag, 'formula', ODF.table);
        }
        if (isElement(tag, new Set([ODF.table]), 'table-row')) {
          if (!tag.closing) {
            rowCells = 0;
            rowRepeat = repeatedCount(tag, 'number-rows-repeated');
            if (rowRepeat > MAX_CELLS) throw new Error('WORKBOOK_RESOURCE_REJECTED');
          } else {
            cells += rowCells * rowRepeat;
            if (cells > MAX_CELLS) throw new Error('WORKBOOK_RESOURCE_REJECTED');
          }
        }
        const href = attribute(tag, 'href', ODF.xlink);
        if (href !== undefined && !href.startsWith('#')) {
          const userHyperlink =
            isElement(tag, new Set([ODF.text]), 'a') ||
            isElement(tag, new Set([ODF.draw]), 'a');
          const safe = (() => {
            if (!userHyperlink || href.length > 2048) return false;
            try {
              const url = new URL(href);
              return (
                url.protocol === 'https:' &&
                url.username === '' &&
                url.password === '' &&
                url.hostname !== ''
              );
            } catch {
              return false;
            }
          })();
          if (!safe) return removeAttribute(raw, tag, 'href', ODF.xlink);
        }
        return raw;
      })
      .join('');
    if (sheets > MAX_SHEETS || cells > MAX_CELLS) throw new Error('WORKBOOK_RESOURCE_REJECTED');
    output.push({ name: entry.name, content: Buffer.from(xml) });
  }
  return { bytes: storedZip(output), hiddenSheets };
}
function storedZip(entries: readonly ZipOutputEntry[]): Uint8Array {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  let outputSize = 22;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const content = Buffer.from(entry.content);
    outputSize += 76 + name.length * 2 + content.length;
    if (outputSize > MAX_OUTPUT_BYTES) throw new Error('WORKBOOK_RESOURCE_REJECTED');
    const checksum = crc32(content);
    const local = Buffer.alloc(30 + name.length + content.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    content.copy(local, 30 + name.length);
    localParts.push(local);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    localOffset += local.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

export function rewriteWorkbook(
  bytes: Uint8Array,
  mediaType: Extract<
    SourceMediaType,
    | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    | 'application/vnd.oasis.opendocument.spreadsheet'
  >,
): RewrittenWorkbook {
  const entries = readValidatedOfficeContainer(bytes, mediaType).map((entry) => ({
    name: entry.name,
    content: entry.content,
  }));
  return mediaType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ? xlsx(entries)
    : ods(entries);
}
