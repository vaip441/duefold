import { validateSourceBytes, type SourceMediaType } from '../source-validation.ts';
import {
  invokeSandboxed,
  sandboxProgram,
  type SandboxLimits,
  type SandboxProgram,
} from './sandbox.ts';
import type { SandboxIsolation } from './preflight.ts';
import { fileURLToPath } from 'node:url';

export interface PositionalText {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly link?: string;
}
export interface RenderedPage {
  readonly mediaType: 'image/png' | 'image/webp';
  readonly image: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly accessibleLabel: string;
  readonly textLayer?: readonly PositionalText[];
}
export interface ProcessedDocument {
  readonly pages: readonly RenderedPage[];
  readonly hiddenSheets: readonly string[];
}
export interface ProcessorPrograms {
  readonly pdf: SandboxProgram;
  readonly office: SandboxProgram;
  readonly image: SandboxProgram;
  readonly text: SandboxProgram;
}
export interface ProcessorProgramTools {
  readonly pdf: string;
  readonly office: string;
  readonly image: string;
  readonly text: string;
}

/**
 * Constructs the exact credential-free processor programs used by production.
 * Image smoke and worker startup share this factory so adapter arguments and
 * required-file mounts cannot drift independently.
 */
export function createProcessorPrograms(tools: ProcessorProgramTools): ProcessorPrograms {
  const processorAdapter = fileURLToPath(new URL('./tool-adapter.ts', import.meta.url));
  const workbookAdapter = fileURLToPath(new URL('./workbook-adapter.ts', import.meta.url));
  const workbookRewriter = fileURLToPath(new URL('./workbook-rewriter.ts', import.meta.url));
  const sourceValidation = fileURLToPath(new URL('../source-validation.ts', import.meta.url));
  const resourcePolicy = fileURLToPath(new URL('../resource-policy.ts', import.meta.url));
  return {
    pdf: sandboxProgram(process.execPath, [processorAdapter, tools.pdf, 'pdf']),
    office: sandboxProgram(
      process.execPath,
      [workbookAdapter, tools.office, tools.pdf],
      [workbookAdapter, processorAdapter, workbookRewriter, sourceValidation, resourcePolicy],
    ),
    image: sandboxProgram(process.execPath, [processorAdapter, tools.image, 'image']),
    text: sandboxProgram(process.execPath, [processorAdapter, tools.text, 'text']),
  };
}
interface ChildPage {
  readonly mediaType: unknown;
  readonly imageBase64: unknown;
  readonly width: unknown;
  readonly height: unknown;
  readonly accessibleLabel: unknown;
  readonly textLayer?: unknown;
}
const MAX_PAGES = 10_000;
const MAX_TEXT_ITEMS_PER_PAGE = 100_000;
const MAX_TEXT_LENGTH = 10_000;
const MAX_CSV_ROWS = 100_000;
const MAX_CSV_COLUMNS = 1_000;
const MAX_CELL_LENGTH = 32_768;
const DEFAULT_LIMITS: SandboxLimits = {
  timeoutMilliseconds: 120_000,
  maximumOutputBytes: 300 * 1024 * 1024,
  maximumInputBytes: 250 * 1024 * 1024,
  maximumTemporaryBytes: 1024 * 1024 * 1024,
};
function unsafeExtractedText(value: string): boolean {
  if (value.includes('\0')) return true;
  // Treat source markup lexically instead of enumerating tag names. Bare
  // comparison operators remain prose; a named/closing/declaration/PI construct
  // that reaches its terminator makes the whole extracted layer inert.
  return /<(?:[A-Za-z][^>]*|\/[^>]*|![^>]*|\?[^>]*)(?:>|$)/isu.test(value);
}
function plainText(value: unknown, maximum: number, code: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum)
    throw new Error(code);
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 32 && codeUnit !== 9 && codeUnit !== 10 && codeUnit !== 13)
      throw new Error(code);
  }
  return value;
}
function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 32_768)
    throw new Error('PROCESSOR_RESPONSE_INVALID');
  return value;
}
function structuredHttpsLink(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.hostname === ''
    )
      return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}
function textLayer(value: unknown): readonly PositionalText[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > MAX_TEXT_ITEMS_PER_PAGE) return undefined;
  const layer: PositionalText[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const record = entry as Readonly<Record<string, unknown>>;
    const text = record['text'];
    if (typeof text !== 'string' || text.length < 1 || text.length > MAX_TEXT_LENGTH)
      return undefined;
    if (unsafeExtractedText(text)) return undefined;
    try {
      const link = structuredHttpsLink(record['link']);
      layer.push({
        text: plainText(text, MAX_TEXT_LENGTH, 'PROCESSOR_UNSAFE_TEXT'),
        x: finite(record['x']),
        y: finite(record['y']),
        width: finite(record['width']),
        height: finite(record['height']),
        ...(link === undefined ? {} : { link }),
      });
    } catch {
      return undefined;
    }
  }
  return layer;
}
function inspectedImage(
  bytes: Uint8Array,
  mediaType: 'image/png' | 'image/webp',
  expectedWidth: number,
  expectedHeight: number,
): void {
  validateSourceBytes(bytes, mediaType);
  let width: number;
  let height: number;
  const buffer = Buffer.from(bytes);
  if (mediaType === 'image/png') {
    width = buffer.readUInt32BE(16);
    height = buffer.readUInt32BE(20);
  } else {
    const kind = buffer.subarray(12, 16).toString('ascii');
    if (kind === 'VP8X') {
      width = 1 + buffer.readUIntLE(24, 3);
      height = 1 + buffer.readUIntLE(27, 3);
    } else if (kind === 'VP8L') {
      const bits = buffer.readUInt32LE(21);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    } else throw new Error('PROCESSOR_RESPONSE_INVALID');
  }
  if (width !== expectedWidth || height !== expectedHeight)
    throw new Error('PROCESSOR_RESPONSE_INVALID');
}
export function parseProcessorOutput(bytes: Uint8Array): ProcessedDocument {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
  } catch {
    throw new Error('PROCESSOR_RESPONSE_INVALID');
  }
  if (typeof value !== 'object' || value === null)
    throw new Error('PROCESSOR_RESPONSE_INVALID');
  const record = value as Readonly<Record<string, unknown>>;
  if (
    ['arguments', 'rewrite', 'office', 'render', 'response'].includes(
      typeof record['processorError'] === 'string' ? record['processorError'] : '',
    )
  )
    throw new Error(`PROCESSOR_${String(record['processorError']).toUpperCase()}_FAILED`);
  if (
    !Array.isArray(record['pages']) ||
    record['pages'].length < 1 ||
    record['pages'].length > MAX_PAGES
  )
    throw new Error('PROCESSOR_RESPONSE_INVALID');
  const hidden = record['hiddenSheets'] ?? [];
  if (!Array.isArray(hidden) || hidden.length > 1_000)
    throw new Error('PROCESSOR_RESPONSE_INVALID');
  const hiddenSheets = hidden.map((name: unknown) =>
    plainText(name, 255, 'PROCESSOR_UNSAFE_TEXT'),
  );
  const pages = record['pages'].map((raw: unknown, index: number): RenderedPage => {
    if (typeof raw !== 'object' || raw === null) throw new Error('PROCESSOR_RESPONSE_INVALID');
    const page = raw as ChildPage;
    if (page.mediaType !== 'image/png' && page.mediaType !== 'image/webp')
      throw new Error('PROCESSOR_RESPONSE_INVALID');
    const width = finite(page.width);
    const height = finite(page.height);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
      throw new Error('PROCESSOR_RESPONSE_INVALID');
    if (
      typeof page.imageBase64 !== 'string' ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
        page.imageBase64,
      )
    )
      throw new Error('PROCESSOR_RESPONSE_INVALID');
    const image = Buffer.from(page.imageBase64, 'base64');
    if (image.length < 1) throw new Error('PROCESSOR_RESPONSE_INVALID');
    inspectedImage(image, page.mediaType, width, height);
    const extracted = textLayer(page.textLayer);
    const rawLabel =
      typeof page.accessibleLabel === 'string' && !unsafeExtractedText(page.accessibleLabel)
        ? page.accessibleLabel
        : `Page ${String(index + 1)}`;
    return {
      mediaType: page.mediaType,
      image,
      width,
      height,
      accessibleLabel: plainText(rawLabel, 500, 'PROCESSOR_RESPONSE_INVALID'),
      ...(extracted === undefined ? {} : { textLayer: extracted }),
    };
  });
  return { pages, hiddenSheets };
}
function argumentsFor(mediaType: SourceMediaType): readonly string[] {
  switch (mediaType) {
    case 'application/pdf':
      return [
        'render-pdf',
        '--raster-format=png',
        '--positional-text=sanitized',
        '--disable-actions',
        '--disable-embedded-media',
      ];
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return ['xlsx'];
    case 'application/vnd.oasis.opendocument.spreadsheet':
      return ['ods'];
    case 'text/plain':
      return [
        'render-text',
        '--format=text',
        '--non-html',
        '--max-cell-length',
        String(MAX_CELL_LENGTH),
        '--paginate',
      ];
    case 'text/csv':
      return [
        'render-text',
        '--format=csv',
        '--non-html',
        '--formula-cells=inert-text',
        '--max-rows',
        String(MAX_CSV_ROWS),
        '--max-columns',
        String(MAX_CSV_COLUMNS),
        '--max-cell-length',
        String(MAX_CELL_LENGTH),
        '--paginate',
      ];
    case 'image/png':
    case 'image/jpeg':
    case 'image/webp':
      return ['render-image', '--header-bounds-first', '--strip-metadata', '--reencode=png'];
  }
}
function programFor(programs: ProcessorPrograms, mediaType: SourceMediaType): SandboxProgram {
  if (mediaType === 'application/pdf') return programs.pdf;
  if (mediaType === 'text/plain' || mediaType === 'text/csv') return programs.text;
  if (mediaType.startsWith('image/')) return programs.image;
  return programs.office;
}
export async function processSource(input: {
  readonly mediaType: SourceMediaType;
  readonly bytes: Uint8Array;
  readonly programs: ProcessorPrograms;
  readonly signal?: AbortSignal;
  readonly limits?: SandboxLimits;
  readonly isolation?: SandboxIsolation;
}): Promise<ProcessedDocument> {
  const output = await invokeSandboxed({
    program: programFor(input.programs, input.mediaType),
    arguments: argumentsFor(input.mediaType),
    input: input.bytes,
    limits: input.limits ?? DEFAULT_LIMITS,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.isolation === undefined || input.isolation.mode === 'namespaced'
      ? {}
      : { mode: input.isolation.mode, identities: input.isolation.identities }),
  });
  return parseProcessorOutput(output);
}
export const processorArgumentsForTesting = argumentsFor;
export const structuredHttpsLinkForTesting = structuredHttpsLink;
