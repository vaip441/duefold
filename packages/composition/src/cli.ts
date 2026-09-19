/**
 * Composition CLI: `generate` and `verify`.
 *
 * `verify` proves the omission invariant by
 * regenerating registries for a manifest and asserting that no artifact
 * references an omitted module.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MODULE_IDS, type ModuleId } from './contract.ts';
import { generate } from './generate.ts';
import { ManifestError } from './manifest.ts';

const GENERATED_FILES = [
  'manifest.ts',
  'routes.ts',
  'migrations.ts',
  'jobs.ts',
  'config-schema.ts',
  'browser-entries.ts',
] as const;

function usage(): never {
  process.stderr.write(
    `usage: compose <generate|verify> [--manifest <path>] [--root <path>]\n`,
  );
  process.exit(2);
}

function parseArgs(argv: readonly string[]): {
  command: 'generate' | 'verify';
  manifestPath: string;
  repoRoot: string;
} {
  const [command, ...rest] = argv;
  if (command !== 'generate' && command !== 'verify') {
    usage();
  }
  let manifestPath = 'composition.manifest.json';
  let repoRoot = process.cwd();
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (flag === '--manifest' && value !== undefined) {
      manifestPath = value;
      index += 1;
    } else if (flag === '--root' && value !== undefined) {
      repoRoot = value;
      index += 1;
    } else {
      usage();
    }
  }
  return { command, manifestPath: resolve(repoRoot, manifestPath), repoRoot };
}

async function verifyOmission(repoRoot: string, selected: readonly ModuleId[]): Promise<void> {
  const omitted = MODULE_IDS.filter((id) => !selected.includes(id));
  if (omitted.length === 0) {
    return;
  }
  const failures: string[] = [];
  for (const name of GENERATED_FILES) {
    const path = resolve(repoRoot, '.duefold/generated', name);
    const contents = await readFile(path, 'utf8');
    for (const id of omitted) {
      if (contents.includes(id)) {
        failures.push(`${name} references omitted module ${id}`);
      }
    }
  }
  if (failures.length > 0) {
    throw new ManifestError(`omission invariant violated:\n  ${failures.join('\n  ')}`);
  }
  process.stdout.write(
    `omission verified: ${omitted.join(', ')} absent from generated registries\n`,
  );
}

async function main(): Promise<void> {
  const { command, manifestPath, repoRoot } = parseArgs(process.argv.slice(2));
  const result = await generate({ repoRoot, manifestPath });
  process.stdout.write(
    `composed ${result.manifest.modules.length} modules -> ${result.writtenFiles.length} registries\n`,
  );
  if (command === 'verify') {
    await verifyOmission(repoRoot, result.manifest.modules);
  }
}

try {
  await main();
} catch (cause) {
  if (cause instanceof ManifestError) {
    process.stderr.write(`composition failed: ${cause.message}\n`);
    process.exit(1);
  }
  throw cause;
}
