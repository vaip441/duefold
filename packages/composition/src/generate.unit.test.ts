import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  REQUIRED_MODULE_IDS,
  type ModuleDeclaration,
  type RouteDeclaration,
} from './contract.ts';
import { generate } from './generate.ts';

const routes: readonly RouteDeclaration[] = [
  {
    id: 'ready',
    method: 'GET',
    path: '/ready',
    audience: 'public',
    handler: 'routes/ready.ts',
  },
  {
    id: 'factory',
    method: 'GET',
    path: '/factory',
    audience: 'public',
    handler: 'routes/factory.ts',
    handlerFactoryExport: 'createHandler',
  },
];

it('imports a ready handler only from routes that declare no runtime factory', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'duefold-compose-test-'));
  try {
    for (const id of REQUIRED_MODULE_IDS) {
      const declaration: ModuleDeclaration = {
        id,
        packageName: `@duefold/${id}`,
        routes: id === 'core-security' ? routes : [],
        migrations: [],
        jobs: [],
        config: [],
        browserEntries: [],
        requires: [],
      };
      await mkdir(join(repoRoot, 'modules', id, 'src'), { recursive: true });
      await writeFile(
        join(repoRoot, 'modules', id, 'src/declaration.ts'),
        `export const moduleDeclaration = ${JSON.stringify(declaration)};\n`,
      );
    }
    const manifestPath = join(repoRoot, 'composition.manifest.json');
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: 1,
        modules: REQUIRED_MODULE_IDS,
        adapters: { storage: 's3-compatible', mail: 'smtp', identity: 'oidc' },
      }),
    );

    await generate({ repoRoot, manifestPath });

    const registry = await readFile(join(repoRoot, '.duefold/generated/routes.ts'), 'utf8');
    expect(registry).toContain(
      "import { handler as handler0, schema as schema0 } from '../../modules/core-security/src/routes/ready.ts';",
    );
    expect(registry).toContain(
      "import { createHandler as factory1, schema as schema1 } from '../../modules/core-security/src/routes/factory.ts';",
    );
    expect(registry).toContain('handler: handler0,');
    expect(registry).toContain('handlerFactory: factory1,');
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
