/**
 * Static client delivery tests.
 *
 * The security property is that only paths present in the build output can be
 * served. These assert it directly, including against traversal attempts, and
 * assert that `/api` never falls through to the application shell.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadStaticClient, resolveStaticAsset } from './static-client.ts';

async function buildOutput(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'duefold-static-'));
  await mkdir(resolve(directory, 'assets'), { recursive: true });
  await writeFile(resolve(directory, 'index.html'), '<!doctype html><html></html>');
  await writeFile(resolve(directory, 'assets/index-abc123.js'), 'export default 1;');
  await writeFile(resolve(directory, 'assets/index-abc123.css'), 'body{}');
  await writeFile(resolve(directory, 'assets/font-abc.woff2'), 'binary');
  return directory;
}

describe('manifest construction', () => {
  it('fails loudly when the client has not been built', async () => {
    await expect(
      loadStaticClient(resolve(tmpdir(), 'duefold-absent-build-output')),
    ).rejects.toThrow(/browser client build output is missing/u);
  });

  it('fails when the build output has no entry document', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'duefold-static-'));
    await mkdir(resolve(directory, 'assets'), { recursive: true });
    await writeFile(resolve(directory, 'assets/index-abc123.js'), 'export default 1;');
    await expect(loadStaticClient(directory)).rejects.toThrow(/no index\.html/u);
  });

  it('indexes every build artifact by its exact request path', async () => {
    const client = await loadStaticClient(await buildOutput());
    expect([...client.assets.keys()].toSorted()).toStrictEqual([
      '/assets/font-abc.woff2',
      '/assets/index-abc123.css',
      '/assets/index-abc123.js',
      '/index.html',
    ]);
  });

  it('never serves source maps', async () => {
    const directory = await buildOutput();
    await writeFile(resolve(directory, 'assets/index-abc123.js.map'), '{"version":3}');
    const client = await loadStaticClient(directory);
    expect(client.assets.has('/assets/index-abc123.js.map')).toBe(false);
  });

  it('refuses an artifact whose type it cannot state', async () => {
    const directory = await buildOutput();
    await writeFile(resolve(directory, 'unexpected.bin'), 'bytes');
    await expect(loadStaticClient(directory)).rejects.toThrow(
      /unexpected client build artifact/u,
    );
  });
});

describe('path resolution', () => {
  it('serves the shell at the root and for client-side routes', async () => {
    const client = await loadStaticClient(await buildOutput());
    for (const path of ['/', '/sign-in', '/read/anything', '/deeply/nested/route'])
      expect(resolveStaticAsset(client, path)?.contentType, path).toBe(
        'text/html; charset=utf-8',
      );
  });

  it('serves an exact build asset with its own content type', async () => {
    const client = await loadStaticClient(await buildOutput());
    expect(resolveStaticAsset(client, '/assets/index-abc123.js')?.contentType).toBe(
      'text/javascript; charset=utf-8',
    );
    expect(resolveStaticAsset(client, '/assets/font-abc.woff2')?.contentType).toBe(
      'font/woff2',
    );
  });

  it('never serves an API path from the client bundle', async () => {
    const client = await loadStaticClient(await buildOutput());
    for (const path of ['/api', '/api/', '/api/auth/session', '/api/does-not-exist'])
      expect(resolveStaticAsset(client, path), path).toBeUndefined();
  });

  it('404s a missing build asset instead of answering with the shell', async () => {
    // Answering an asset miss with HTML would make a stale asset URL look like a
    // working page.
    const client = await loadStaticClient(await buildOutput());
    expect(resolveStaticAsset(client, '/assets/index-stale.js')).toBeUndefined();
  });

  it('cannot be walked out of the build output', async () => {
    const client = await loadStaticClient(await buildOutput());
    for (const attempt of [
      '/assets/../../../etc/passwd',
      '/assets/%2e%2e%2f%2e%2e%2fetc/passwd',
      '/../package.json',
      '/assets/./../../secrets',
    ]) {
      const resolved = resolveStaticAsset(client, attempt);
      // Either nothing (an /assets miss) or the shell — never file content, and
      // never anything outside the manifest.
      if (resolved !== undefined)
        expect(resolved.contentType, attempt).toBe('text/html; charset=utf-8');
    }
  });

  it('marks content-hashed assets immutable and the shell not', async () => {
    const client = await loadStaticClient(await buildOutput());
    expect(resolveStaticAsset(client, '/assets/index-abc123.js')?.immutable).toBe(true);
    expect(resolveStaticAsset(client, '/')?.immutable).toBe(false);
  });
});
