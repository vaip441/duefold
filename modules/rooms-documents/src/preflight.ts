import {
  MAX_DIRECTORY_FILES,
  MAX_DIRECTORY_LEVELS,
  MAX_DIRECTORY_TOTAL_BYTES,
  MAX_SOURCE_BYTES,
} from './resource-policy.ts';

const SUPPORTED_EXTENSIONS = new Set([
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'txt',
  'csv',
  'xlsx',
  'ods',
]);
const SAFE_SEGMENT = /^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,199}$/u;
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
  if (
    entry.path.startsWith('/') ||
    entry.path.startsWith('\\') ||
    /^[A-Za-z]:/u.test(entry.path)
  )
    throw new Error('PREFLIGHT_ABSOLUTE_PATH_REJECTED');
  const canonical = entry.path.replaceAll('\\', '/').normalize('NFC');
  const segments = canonical.split('/');
  if (
    segments.length < 1 ||
    segments.length > MAX_DIRECTORY_LEVELS + 1 ||
    segments.some(
      (segment) =>
        segment === '' || segment === '.' || segment === '..' || !SAFE_SEGMENT.test(segment),
    )
  )
    throw new Error('PREFLIGHT_PATH_REJECTED');
  const filename = segments.at(-1);
  if (filename === undefined) throw new Error('PREFLIGHT_PATH_REJECTED');
  const extensionOffset = filename.lastIndexOf('.');
  const basename = extensionOffset < 0 ? filename : filename.slice(0, extensionOffset);
  const extension =
    extensionOffset < 0 ? '' : filename.slice(extensionOffset + 1).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) throw new Error('PREFLIGHT_TYPE_REJECTED');
  for (const segment of segments.slice(0, -1)) rejectMixedScriptSegment(segment);
  rejectMixedScriptSegment(basename);
  return { path: segments.join('/'), segments, size: entry.size };
}

/** Advisory browser preflight. Identical size/type/depth limits are enforced by
 * server intent/finalization and worker validation; callers cannot bypass them. */
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
