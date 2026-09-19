/**
 * Manifest loading and validation.
 *
 * An unknown module id, an unknown configuration key, a missing required
 * module, or an unsatisfied module dependency fails the build. Validation is a
 * build-time and startup-time gate, never a runtime negotiation.
 */

import { readFile } from 'node:fs/promises';
import {
  isModuleId,
  isRequiredModule,
  MODULE_IDS,
  REQUIRED_MODULE_IDS,
  type CompositionManifest,
  type ModuleDeclaration,
  type ModuleId,
} from './contract.ts';

export class ManifestError extends Error {
  public override readonly name = 'ManifestError';
}

function fail(message: string): never {
  throw new ManifestError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses and validates manifest JSON without touching the filesystem. */
export function parseManifest(raw: string, source: string): CompositionManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    fail(`${source}: manifest is not valid JSON: ${(cause as Error).message}`);
  }

  if (!isRecord(parsed)) {
    fail(`${source}: manifest must be a JSON object`);
  }

  const known = new Set(['version', 'modules', 'adapters']);
  for (const key of Object.keys(parsed)) {
    if (!known.has(key)) {
      fail(`${source}: unknown manifest key ${JSON.stringify(key)}`);
    }
  }

  if (parsed['version'] !== 1) {
    fail(`${source}: manifest version must be 1`);
  }

  const modulesValue = parsed['modules'];
  if (!Array.isArray(modulesValue) || modulesValue.length === 0) {
    fail(`${source}: manifest.modules must be a non-empty array`);
  }

  const modules: ModuleId[] = [];
  for (const entry of modulesValue) {
    if (typeof entry !== 'string' || !isModuleId(entry)) {
      fail(
        `${source}: unknown module ${JSON.stringify(entry)}; known modules are ${MODULE_IDS.join(', ')}`,
      );
    }
    if (modules.includes(entry)) {
      fail(`${source}: module ${entry} is listed more than once`);
    }
    modules.push(entry);
  }

  for (const required of REQUIRED_MODULE_IDS) {
    if (!modules.includes(required)) {
      fail(`${source}: secure core requires module ${required}`);
    }
  }

  const adaptersValue = parsed['adapters'];
  if (!isRecord(adaptersValue)) {
    fail(`${source}: manifest.adapters must be an object`);
  }
  const adapterKeys = new Set(['storage', 'mail', 'identity']);
  for (const key of Object.keys(adaptersValue)) {
    if (!adapterKeys.has(key)) {
      fail(`${source}: unknown adapter key ${JSON.stringify(key)}`);
    }
  }
  if (adaptersValue['storage'] !== 's3-compatible') {
    fail(`${source}: adapters.storage must be "s3-compatible"`);
  }
  if (adaptersValue['mail'] !== 'smtp' && adaptersValue['mail'] !== 'resend') {
    fail(`${source}: adapters.mail must be exactly one of "smtp" or "resend"`);
  }
  if (adaptersValue['identity'] !== 'oidc') {
    fail(`${source}: adapters.identity must be "oidc"`);
  }

  return {
    version: 1,
    modules,
    adapters: {
      storage: 's3-compatible',
      mail: adaptersValue['mail'],
      identity: 'oidc',
    },
  };
}

export async function loadManifest(path: string): Promise<CompositionManifest> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (cause) {
    fail(`cannot read composition manifest at ${path}: ${(cause as Error).message}`);
  }
  return parseManifest(raw, path);
}

/**
 * Validates declarations against the selected manifest. Rejects declarations
 * from omitted modules, unsatisfied dependencies, duplicate route/migration/job
 * ids, and duplicate configuration keys.
 */
export function validateDeclarations(
  manifest: CompositionManifest,
  declarations: readonly ModuleDeclaration[],
): void {
  const selected = new Set<ModuleId>(manifest.modules);

  for (const declaration of declarations) {
    if (!selected.has(declaration.id)) {
      fail(
        `module ${declaration.id} supplied a declaration but is not selected by the manifest`,
      );
    }
  }

  const declared = new Set(declarations.map((entry) => entry.id));
  for (const id of selected) {
    if (!declared.has(id)) {
      fail(`selected module ${id} supplied no declaration`);
    }
  }

  for (const declaration of declarations) {
    for (const dependency of declaration.requires) {
      if (!selected.has(dependency)) {
        fail(`module ${declaration.id} requires ${dependency}, which the manifest omits`);
      }
    }
    if (!isRequiredModule(declaration.id) && declaration.requires.length === 0) {
      // Optional modules may stand alone; nothing to assert.
    }
  }

  assertUnique(
    declarations.flatMap((entry) =>
      entry.routes.map((route) => `${route.method} ${route.path}`),
    ),
    'route',
  );
  assertUnique(
    declarations.flatMap((entry) => entry.routes.map((route) => route.id)),
    'route id',
  );
  assertUnique(
    declarations.flatMap((entry) => entry.migrations.map((migration) => migration.id)),
    'migration id',
  );
  assertUnique(
    declarations.flatMap((entry) => entry.jobs.map((job) => job.id)),
    'job id',
  );
  assertUnique(
    declarations.flatMap((entry) => entry.config.map((field) => field.key)),
    'configuration key',
  );
  assertUnique(
    declarations.flatMap((entry) => entry.browserEntries.map((browser) => browser.id)),
    'browser entry id',
  );
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      fail(`duplicate ${label}: ${value}`);
    }
    seen.add(value);
  }
}
