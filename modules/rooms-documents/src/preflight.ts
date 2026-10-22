import {
  MAX_DIRECTORY_FILES,
  MAX_DIRECTORY_LEVELS,
  MAX_DIRECTORY_TOTAL_BYTES,
  MAX_SOURCE_BYTES,
} from './resource-policy.ts';
import type { SourceMediaType } from './source-validation.ts';

/* Shared by the browser preflight and the server intent, so the two cannot disagree on
   which extension declares which type. Bytes still decide the type (§11.1). */
const MEDIA_TYPE_EXTENSIONS: Readonly<Record<SourceMediaType, readonly string[]>> = {
  'application/pdf': ['pdf'],
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/webp': ['webp'],
  'text/plain': ['txt'],
  'text/csv': ['csv'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'application/vnd.oasis.opendocument.spreadsheet': ['ods'],
};
const SCRIPT_PATTERNS = [
  { name: 'Latin', pattern: /\p{Script_Extensions=Latin}/u },
  { name: 'Cyrillic', pattern: /\p{Script_Extensions=Cyrillic}/u },
  { name: 'Greek', pattern: /\p{Script_Extensions=Greek}/u },
  { name: 'Armenian', pattern: /\p{Script_Extensions=Armenian}/u },
  { name: 'Hebrew', pattern: /\p{Script_Extensions=Hebrew}/u },
  { name: 'Arabic', pattern: /\p{Script_Extensions=Arabic}/u },
  { name: 'Devanagari', pattern: /\p{Script_Extensions=Devanagari}/u },
  { name: 'Han', pattern: /\p{Script_Extensions=Han}/u },
  { name: 'Hiragana', pattern: /\p{Script_Extensions=Hiragana}/u },
  { name: 'Katakana', pattern: /\p{Script_Extensions=Katakana}/u },
  { name: 'Hangul', pattern: /\p{Script_Extensions=Hangul}/u },
] as const;
type SupportedScript = (typeof SCRIPT_PATTERNS)[number]['name'];
const JAPANESE_SCRIPTS = new Set<SupportedScript>(['Han', 'Hiragana', 'Katakana']);
const KOREAN_SCRIPTS = new Set<SupportedScript>(['Han', 'Hangul']);
const CONFUSABLE_ASCII = new Map<string, string>([
  ['а', 'a'],
  ['е', 'e'],
  ['о', 'o'],
  ['р', 'p'],
  ['с', 'c'],
  ['у', 'y'],
  ['х', 'x'],
  ['і', 'i'],
  ['ј', 'j'],
  ['κ', 'k'],
  ['ο', 'o'],
  ['ρ', 'p'],
  ['υ', 'y'],
  ['χ', 'x'],
]);
export interface DirectoryUploadEntry {
  readonly path: string;
  readonly size: number;
}
export interface NormalizedDirectoryEntry {
  readonly path: string;
  readonly segments: readonly string[];
  readonly size: number;
  readonly mediaType: SourceMediaType;
}

export function mediaTypeForFilename(filename: string): SourceMediaType | null {
  const separator = filename.lastIndexOf('.');
  const extension = separator < 0 ? '' : filename.slice(separator + 1).toLowerCase();
  return (
    (Object.keys(MEDIA_TYPE_EXTENSIONS) as SourceMediaType[]).find((mediaType) =>
      MEDIA_TYPE_EXTENSIONS[mediaType].includes(extension),
    ) ?? null
  );
}

/* Mirrors the server's name rule (uploads.ts safeName). */
function unsafeSegment(segment: string): boolean {
  return (
    segment === '' ||
    segment === '.' ||
    segment === '..' ||
    segment.length > 200 ||
    Array.from(segment).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127 || character === '\\';
    })
  );
}

function rejectMixedScriptSegment(segment: string): void {
  const letters = Array.from(segment).filter((character) => /\p{L}/u.test(character));
  const scripts = new Set<SupportedScript>();
  for (const letter of letters) {
    const script = SCRIPT_PATTERNS.find(({ pattern }) => pattern.test(letter))?.name;
    if (script === undefined) throw new Error('PREFLIGHT_CONFUSABLE_REJECTED');
    scripts.add(script);
  }
  if (
    scripts.size > 1 &&
    !Array.from(scripts).every((script) => JAPANESE_SCRIPTS.has(script)) &&
    !Array.from(scripts).every((script) => KOREAN_SCRIPTS.has(script))
  )
    throw new Error('PREFLIGHT_CONFUSABLE_REJECTED');
}

function confusableCollisionKey(path: string): string {
  return Array.from(
    path.toLocaleLowerCase('en-US'),
    (character) => CONFUSABLE_ASCII.get(character) ?? character,
  ).join('');
}

function normalizeEntry(entry: DirectoryUploadEntry): NormalizedDirectoryEntry {
  if (!Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > MAX_SOURCE_BYTES)
    throw new Error('PREFLIGHT_FILE_SIZE_REJECTED');
  if (entry.path.startsWith('/') || /^[A-Za-z]:/u.test(entry.path))
    throw new Error('PREFLIGHT_ABSOLUTE_PATH_REJECTED');
  const canonical = entry.path.normalize('NFC');
  const segments = canonical.split('/');
  if (
    segments.length < 1 ||
    segments.length > MAX_DIRECTORY_LEVELS + 1 ||
    segments.some(unsafeSegment)
  )
    throw new Error('PREFLIGHT_PATH_REJECTED');
  const filename = segments.at(-1);
  if (filename === undefined) throw new Error('PREFLIGHT_PATH_REJECTED');
  const extensionOffset = filename.lastIndexOf('.');
  const basename = extensionOffset < 0 ? filename : filename.slice(0, extensionOffset);
  const mediaType = mediaTypeForFilename(filename);
  if (mediaType === null) throw new Error('PREFLIGHT_TYPE_REJECTED');
  for (const segment of segments.slice(0, -1)) rejectMixedScriptSegment(segment);
  rejectMixedScriptSegment(basename);
  return { path: segments.join('/'), segments, size: entry.size, mediaType };
}

/** Advisory browser preflight. Per-file size and type are enforced again by server
 * intent/finalization and worker validation, and folder depth by the working structure;
 * the directory file-count and aggregate-size limits are enforced only here. */
export function preflightDirectoryUpload(
  entries: readonly DirectoryUploadEntry[],
): readonly NormalizedDirectoryEntry[] {
  if (entries.length < 1 || entries.length > MAX_DIRECTORY_FILES)
    throw new Error('PREFLIGHT_COUNT_REJECTED');
  const normalized = entries.map(normalizeEntry);
  let total = 0;
  const collisionKeys = new Set<string>();
  const confusableCollisionKeys = new Set<string>();
  for (const entry of normalized) {
    total += entry.size;
    if (total > MAX_DIRECTORY_TOTAL_BYTES) throw new Error('PREFLIGHT_TOTAL_SIZE_REJECTED');
    const collisionKey = entry.path.toLocaleLowerCase('en-US');
    if (collisionKeys.has(collisionKey)) throw new Error('PREFLIGHT_COLLISION_REJECTED');
    const confusableKey = confusableCollisionKey(entry.path);
    if (confusableCollisionKeys.has(confusableKey))
      throw new Error('PREFLIGHT_CONFUSABLE_REJECTED');
    collisionKeys.add(collisionKey);
    confusableCollisionKeys.add(confusableKey);
  }
  return normalized;
}
