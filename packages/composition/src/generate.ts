/**
 * Registry generator.
 *
 * The generator runs at build time only. It reads the reviewed manifest, loads
 * the declaration file of each *selected* module, validates the composition,
 * and emits `.duefold/generated/` registry modules whose imports name only
 * selected modules.
 *
 * Because the generated registries are the sole entry point the applications
 * import from, an omitted module leaves no import edge, no route, no migration,
 * no job, no configuration key, and no browser chunk. Nothing in the running
 * application scans the filesystem or consults a feature flag.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  CompositionManifest,
  ModuleDeclaration,
  ModuleId,
  RouteDeclaration,
} from './contract.ts';
import { loadManifest, ManifestError, validateDeclarations } from './manifest.ts';

const GENERATED_DIR = '.duefold/generated';

const GENERATED_HEADER = `// GENERATED FILE — DO NOT EDIT.
// Produced by @duefold/composition from the reviewed composition manifest.
// Run \`npm run compose\` to regenerate.
`;

export interface GenerateOptions {
  readonly repoRoot: string;
  readonly manifestPath: string;
}

export interface GenerateResult {
  readonly manifest: CompositionManifest;
  readonly declarations: readonly ModuleDeclaration[];
  readonly writtenFiles: readonly string[];
}

function moduleDirectory(repoRoot: string, id: ModuleId): string {
  return resolve(repoRoot, 'modules', id);
}

async function loadDeclaration(repoRoot: string, id: ModuleId): Promise<ModuleDeclaration> {
  const declarationPath = resolve(moduleDirectory(repoRoot, id), 'src/declaration.ts');
  let loaded: unknown;
  try {
    loaded = await import(pathToFileURL(declarationPath).href);
  } catch (cause) {
    throw new ManifestError(
      `cannot load declaration for module ${id} at ${declarationPath}: ${(cause as Error).message}`,
    );
  }
  const declaration = (loaded as { moduleDeclaration?: unknown }).moduleDeclaration;
  if (declaration === undefined) {
    throw new ManifestError(`${declarationPath} must export \`moduleDeclaration\``);
  }
  const typed = declaration as ModuleDeclaration;
  if (typed.id !== id) {
    throw new ManifestError(
      `${declarationPath} declares id ${typed.id} but lives in modules/${id}`,
    );
  }
  return typed;
}

/** Mutating methods default to CSRF-verified. */
function routeRequiresCsrf(route: RouteDeclaration): boolean {
  if (route.csrf !== undefined) {
    return route.csrf;
  }
  return route.method !== 'GET' && route.method !== 'HEAD';
}

function importSpecifier(fromFile: string, target: string): string {
  const relativePath = relative(dirname(fromFile), target).replaceAll('\\', '/');
  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
}

export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  const manifest = await loadManifest(options.manifestPath);
  const declarations: ModuleDeclaration[] = [];
  for (const id of manifest.modules) {
    declarations.push(await loadDeclaration(options.repoRoot, id));
  }
  validateDeclarations(manifest, declarations);

  const outDir = resolve(options.repoRoot, GENERATED_DIR);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const written: string[] = [];
  const emit = async (name: string, contents: string): Promise<void> => {
    const target = resolve(outDir, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
    written.push(relative(options.repoRoot, target));
  };

  await emit('manifest.ts', renderManifest(manifest));
  await emit('routes.ts', renderRoutes(options.repoRoot, outDir, declarations));
  await emit('migrations.ts', renderMigrations(options.repoRoot, outDir, declarations));
  await emit('jobs.ts', renderJobs(options.repoRoot, outDir, declarations));
  await emit('config-schema.ts', renderConfigSchema(declarations));
  await emit(
    'browser-entries.ts',
    renderBrowserEntries(options.repoRoot, outDir, declarations),
  );

  return { manifest, declarations, writtenFiles: written };
}

function renderManifest(manifest: CompositionManifest): string {
  return `${GENERATED_HEADER}
import type { CompositionManifest } from '@duefold/composition/contract';

export const composedManifest: CompositionManifest = ${JSON.stringify(manifest, null, 2)} as const;

export const composedModuleIds = ${JSON.stringify(manifest.modules)} as const;

export type ComposedModuleId = (typeof composedModuleIds)[number];

export function isComposedModule(id: string): id is ComposedModuleId {
  return (composedModuleIds as readonly string[]).includes(id);
}
`;
}

function renderRoutes(
  repoRoot: string,
  outDir: string,
  declarations: readonly ModuleDeclaration[],
): string {
  const imports: string[] = [];
  const entries: string[] = [];
  let index = 0;

  for (const declaration of declarations) {
    for (const route of declaration.routes) {
      const local = `handler${index}`;
      index += 1;
      const target = resolve(moduleDirectory(repoRoot, declaration.id), 'src', route.handler);
      const schemaLocal = `schema${index - 1}`;
      const factoryLocal = `factory${index - 1}`;
      const factoryImport =
        route.handlerFactoryExport === undefined
          ? ''
          : `, ${route.handlerFactoryExport} as ${factoryLocal}`;
      imports.push(
        `import { ${route.handlerExport ?? 'handler'} as ${local}, schema as ${schemaLocal}${factoryImport} } from '${importSpecifier(
          resolve(outDir, 'routes.ts'),
          target,
        )}';`,
      );
      entries.push(
        `  {
    id: ${JSON.stringify(route.id)},
    module: ${JSON.stringify(declaration.id)},
    method: ${JSON.stringify(route.method)},
    path: ${JSON.stringify(route.path)},
    audience: ${JSON.stringify(route.audience)},
    csrf: ${routeRequiresCsrf(route)},
    handler: ${local},${
      route.handlerFactoryExport === undefined ? '' : `\n    handlerFactory: ${factoryLocal},`
    }
    schema: ${schemaLocal},
  },`,
      );
    }
  }

  return `${GENERATED_HEADER}
import type { GeneratedRoute } from '@duefold/composition/registry-types';
${imports.join('\n')}

export const generatedRoutes = [
${entries.join('\n')}
] as const satisfies readonly GeneratedRoute[];

export type GeneratedRouteEntry = (typeof generatedRoutes)[number];
export type GeneratedRouteId = GeneratedRouteEntry['id'];
export type GeneratedRouteAudience = GeneratedRouteEntry['audience'];
`;
}

function renderMigrations(
  repoRoot: string,
  outDir: string,
  declarations: readonly ModuleDeclaration[],
): string {
  const entries: string[] = [];
  for (const declaration of declarations) {
    for (const migration of declaration.migrations) {
      const target = resolve(
        moduleDirectory(repoRoot, declaration.id),
        'migrations',
        migration.file,
      );
      entries.push(
        `  {
    id: ${JSON.stringify(migration.id)},
    module: ${JSON.stringify(declaration.id)},
    path: new URL(${JSON.stringify(importSpecifier(resolve(outDir, 'migrations.ts'), target))}, import.meta.url).pathname,
  },`,
      );
    }
  }
  return `${GENERATED_HEADER}
import type { GeneratedMigration } from '@duefold/composition/registry-types';

export const generatedMigrations: readonly GeneratedMigration[] = [
${entries.join('\n')}
];
`;
}

function renderJobs(
  repoRoot: string,
  outDir: string,
  declarations: readonly ModuleDeclaration[],
): string {
  const imports: string[] = [];
  const entries: string[] = [];
  let index = 0;
  for (const declaration of declarations) {
    for (const job of declaration.jobs) {
      const local = `job${index}`;
      index += 1;
      const target = resolve(moduleDirectory(repoRoot, declaration.id), 'src', job.handler);
      imports.push(
        `import { ${job.handlerFactoryExport} as ${local} } from '${importSpecifier(resolve(outDir, 'jobs.ts'), target)}';`,
      );
      entries.push(
        `  {
    id: ${JSON.stringify(job.id)},
    module: ${JSON.stringify(declaration.id)},
    handlerFactory: ${local},
  },`,
      );
    }
  }
  return `${GENERATED_HEADER}
import type { GeneratedJob } from '@duefold/composition/registry-types';
${imports.join('\n')}

export const generatedJobs = [
${entries.join('\n')}
] as const satisfies readonly GeneratedJob[];
`;
}

function renderConfigSchema(declarations: readonly ModuleDeclaration[]): string {
  const entries = declarations.flatMap((declaration) =>
    declaration.config.map(
      (field) => `  {
    key: ${JSON.stringify(field.key)},
    module: ${JSON.stringify(declaration.id)},
    service: ${JSON.stringify(field.service)},
    kind: ${JSON.stringify(field.kind)},
    required: ${field.required},
    description: ${JSON.stringify(field.description)},${
      field.values === undefined ? '' : `\n    values: ${JSON.stringify(field.values)},`
    }${field.default === undefined ? '' : `\n    default: ${JSON.stringify(field.default)},`}
  },`,
    ),
  );
  return `${GENERATED_HEADER}
import type { GeneratedConfigField } from '@duefold/composition/registry-types';

export const generatedConfigSchema: readonly GeneratedConfigField[] = [
${entries.join('\n')}
];

export const generatedConfigKeys: readonly string[] = generatedConfigSchema.map(
  (field) => field.key,
);
`;
}

function renderBrowserEntries(
  repoRoot: string,
  outDir: string,
  declarations: readonly ModuleDeclaration[],
): string {
  const entries: string[] = [];
  for (const declaration of declarations) {
    for (const browser of declaration.browserEntries) {
      const target = resolve(moduleDirectory(repoRoot, declaration.id), 'src', browser.source);
      entries.push(
        `  {
    id: ${JSON.stringify(browser.id)},
    module: ${JSON.stringify(declaration.id)},
    source: ${JSON.stringify(importSpecifier(resolve(outDir, 'browser-entries.ts'), target))},
  },`,
      );
    }
  }
  return `${GENERATED_HEADER}
import type { GeneratedBrowserEntry } from '@duefold/composition/registry-types';

export const generatedBrowserEntries: readonly GeneratedBrowserEntry[] = [
${entries.join('\n')}
];
`;
}
