import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const dist = resolve(repoRoot, 'apps/web-client/dist');
const manifestPath = resolve(dist, '.vite/manifest.json');

const budgets = {
  initial: 70_000,
  authentication: 10_000,
  viewer: 10_000,
  member: 85_000,
} as const;

type BudgetGroup = keyof typeof budgets;
interface ManifestEntry {
  readonly file: string;
  readonly name?: string;
  readonly isEntry?: boolean;
  readonly imports?: readonly string[];
}

function fail(message: string): void {
  process.stderr.write(`browser bundle budget failed: ${message}\n`);
  process.exitCode = 1;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function manifestEntry(value: unknown): ManifestEntry | undefined {
  if (!isRecord(value) || typeof value['file'] !== 'string') return undefined;
  const imports = value['imports'];
  if (
    imports !== undefined &&
    (!Array.isArray(imports) || imports.some((item) => typeof item !== 'string'))
  )
    return undefined;
  return {
    file: value['file'],
    ...(typeof value['name'] === 'string' ? { name: value['name'] } : {}),
    ...(typeof value['isEntry'] === 'boolean' ? { isEntry: value['isEntry'] } : {}),
    ...(imports === undefined ? {} : { imports: imports as readonly string[] }),
  };
}

function parseManifest(value: unknown): ReadonlyMap<string, ManifestEntry> {
  if (!isRecord(value)) throw new Error('build manifest is not an object');
  const parsed = new Map<string, ManifestEntry>();
  for (const [key, rawEntry] of Object.entries(value)) {
    const entry = manifestEntry(rawEntry);
    if (entry === undefined) throw new Error(`invalid build manifest entry: ${key}`);
    parsed.set(key, entry);
  }
  return parsed;
}

function routeGroup(name: string): Exclude<BudgetGroup, 'initial'> | undefined {
  if (name === 'member') return 'member';
  if (name === 'viewer') return 'viewer';
  if (name === 'authentication') return 'authentication';
  return undefined;
}

async function gzipBytes(files: ReadonlySet<string>): Promise<number> {
  let total = 0;
  for (const file of files) total += gzipSync(await readFile(resolve(dist, file))).byteLength;
  return total;
}

async function main(): Promise<void> {
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
  } catch (error: unknown) {
    throw new Error('build manifest missing or invalid; run `npm run build` first', {
      cause: error,
    });
  }
  const manifest = parseManifest(rawManifest);
  const groupedFiles: Record<BudgetGroup, Set<string>> = {
    initial: new Set<string>(),
    authentication: new Set<string>(),
    viewer: new Set<string>(),
    member: new Set<string>(),
  };
  for (const entry of manifest.values()) {
    if (entry.isEntry === true) groupedFiles.initial.add(entry.file);
    const group = routeGroup(entry.name ?? '');
    if (group !== undefined) groupedFiles[group].add(entry.file);
  }

  for (const [group, limit] of Object.entries(budgets) as [BudgetGroup, number][]) {
    const size = await gzipBytes(groupedFiles[group]);
    process.stdout.write(`${group}: ${String(size)} B gzip / ${String(limit)} B budget\n`);
    if (size === 0) fail(`${group} chunk was not emitted`);
    else if (size > limit) fail(`${group} is ${String(size)} B gzip, over ${String(limit)} B`);
  }

  const assets = await readdir(resolve(dist, 'assets'));
  const javascript = assets.filter((name) => name.endsWith('.js'));
  if (javascript.length < 5)
    fail(
      `expected route-level splitting, found only ${String(javascript.length)} JavaScript chunks`,
    );
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
