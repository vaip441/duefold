/**
 * Build-time composition of module browser entries.
 *
 * The generated registry (`.duefold/generated/browser-entries.ts`) records each
 * composed module's browser entry as a source PATH, not an import. A string
 * cannot pull code into a bundle, so this plugin is the loading mechanism: it
 * reads the registry at build time and emits a virtual module containing literal
 * static imports of exactly those paths.
 *
 * A module omitted from the composition manifest has no registry entry, is
 * therefore never named by any import, and cannot appear in the built output.
 * This is deliberately not a runtime plugin loader, a dynamic import, or a
 * feature flag; an omitted module is completely absent from the bundle.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Plugin } from 'vite';

const VIRTUAL_ID = 'virtual:duefold/browser-entries';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

interface RegistryEntry {
  readonly id: string;
  readonly module: string;
  readonly source: string;
}

async function readRegistry(repoRoot: string): Promise<readonly RegistryEntry[]> {
  const registryPath = resolve(repoRoot, '.duefold/generated/browser-entries.ts');
  const loaded: unknown = await import(pathToFileURL(registryPath).href);
  const entries = (loaded as { generatedBrowserEntries?: unknown }).generatedBrowserEntries;
  if (!Array.isArray(entries))
    throw new Error('generated browser-entry registry is missing or malformed');
  return entries.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null)
      throw new Error('malformed browser-entry registry record');
    const record = entry as { id?: unknown; module?: unknown; source?: unknown };
    if (
      typeof record.id !== 'string' ||
      typeof record.module !== 'string' ||
      typeof record.source !== 'string'
    )
      throw new Error('malformed browser-entry registry record');
    return { id: record.id, module: record.module, source: record.source };
  });
}

export function duefoldBrowserEntries(repoRoot: string): Plugin {
  return {
    name: 'duefold-browser-entries',
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },
    async load(id) {
      if (id !== RESOLVED_ID) return null;
      const entries = await readRegistry(repoRoot);
      const generatedDir = resolve(repoRoot, '.duefold/generated');
      const imports = entries.map(
        (entry, index) =>
          `import { contribution as contribution${index} } from ${JSON.stringify(
            resolve(generatedDir, entry.source),
          )};`,
      );
      const records = entries.map(
        (_entry, index) => `  { contribution: contribution${index} },`,
      );
      return `${imports.join('\n')}\nexport const composedBrowserEntries = [\n${records.join(
        '\n',
      )}\n];\n`;
    },
  };
}
