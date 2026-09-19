/**
 * Static delivery of the built browser client.
 *
 * The manifest is an exact-match `Map` built once at startup from the build
 * output. Nothing joins a request path onto a filesystem path, so path
 * traversal is absent as a category rather than mitigated: a URL that was not
 * in the build output has no entry and cannot be served.
 *
 * `/api/*` is never served from here. A missing API route stays a JSON 404
 * instead of falling through to the application shell, so a client bug cannot
 * be mistaken for a route that exists.
 */

import { readdir, readFile } from 'node:fs/promises';
import { extname, posix, resolve } from 'node:path';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/vnd.microsoft.icon',
  '.txt': 'text/plain; charset=utf-8',
};

/** Build output that must never be served to a browser. */
function isExcluded(relativePath: string): boolean {
  return relativePath.endsWith('.map') || relativePath === '.vite/manifest.json';
}

export interface StaticAsset {
  readonly body: Buffer;
  readonly contentType: string;
  /** Content-hashed build assets are immutable; the entry document is not. */
  readonly immutable: boolean;
}

export interface StaticClient {
  readonly assets: ReadonlyMap<string, StaticAsset>;
  readonly document: StaticAsset;
}

async function collect(directory: string, prefix: string): Promise<readonly string[]> {
  const entries = await readdir(resolve(directory, prefix === '' ? '.' : prefix), {
    withFileTypes: true,
  });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = prefix === '' ? entry.name : posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(directory, relativePath)));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

/** Fails loudly when the client has not been built. */
export async function loadStaticClient(directory: string): Promise<StaticClient> {
  let files: readonly string[];
  try {
    files = await collect(directory, '');
  } catch {
    throw new Error(
      'browser client build output is missing; run `npm run build` before starting the web service',
    );
  }
  const assets = new Map<string, StaticAsset>();
  for (const relativePath of files) {
    if (isExcluded(relativePath)) continue;
    const contentType = CONTENT_TYPES[extname(relativePath)];
    if (contentType === undefined)
      throw new Error(`unexpected client build artifact: ${relativePath}`);
    assets.set(`/${relativePath}`, {
      body: await readFile(resolve(directory, relativePath)),
      contentType,
      immutable: relativePath.startsWith('assets/'),
    });
  }
  const document = assets.get('/index.html');
  if (document === undefined) throw new Error('browser client build output has no index.html');
  return { assets, document };
}

/**
 * Resolves one GET path. Returns the application shell for any non-`/api` path
 * the build output does not contain, so client-side routes load directly.
 */
export function resolveStaticAsset(
  client: StaticClient,
  path: string,
): StaticAsset | undefined {
  if (path === '/api' || path.startsWith('/api/')) return undefined;
  if (path === '/') return client.document;
  const exact = client.assets.get(path);
  if (exact !== undefined) return exact;
  // A build asset request that misses is a genuine 404: answering it with HTML
  // would make a stale or wrong asset URL look like a working page.
  if (path.startsWith('/assets/')) return undefined;
  return client.document;
}
