/**
 * Build-time composition proof.
 *
 * The claim is that an omitted module is ABSENT from production artifacts, not
 * inert within them. This test proves it against the actual build output rather
 * than by inspecting source: it composes both manifests, builds the browser
 * bundle for each, and asserts the optional module's code, route, and
 * configuration key are present in one and absent from the other.
 *
 * It runs in the browser project because it needs the real Vite build, which is
 * too slow for the unit project and needs no browser page.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIST_ASSETS = resolve(REPO_ROOT, 'apps/web-client/dist/assets');

/*
 * Marks that exist only because `branding-notifications` was composed.
 *
 * Deliberately the ROUTE PATH, not the module id: a module identifier in public
 * JavaScript would itself disclose composition state, so the
 * bundle is asserted to contain the endpoint the contribution calls and to
 * contain no module identifier at all.
 */
const MODULE_MARKERS = ['/api/branding/support-contact'] as const;
const FORBIDDEN_BUNDLE_MARKERS = [
  'branding-notifications',
  'core-security',
  'rooms-documents',
  'participants-access',
] as const;

function run(command: string, args: readonly string[]): string {
  return execFileSync(command, [...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function composeAndBuild(manifest: string): {
  readonly bundle: string;
  readonly registry: string;
  readonly routes: string;
  readonly config: string;
} {
  run('node', ['packages/composition/src/cli.ts', 'generate', '--manifest', manifest]);
  run('npm', ['run', 'build', '--workspace', '@duefold/web-client']);
  const scripts = readdirSync(DIST_ASSETS).filter((name) => name.endsWith('.js'));
  expect(scripts.length).toBeGreaterThan(0);
  return {
    bundle: scripts.map((name) => readFileSync(resolve(DIST_ASSETS, name), 'utf8')).join('\n'),
    registry: readFileSync(resolve(REPO_ROOT, '.duefold/generated/browser-entries.ts'), 'utf8'),
    routes: readFileSync(resolve(REPO_ROOT, '.duefold/generated/routes.ts'), 'utf8'),
    config: readFileSync(resolve(REPO_ROOT, '.duefold/generated/config-schema.ts'), 'utf8'),
  };
}

test.describe('build-time composition', () => {
  // Serial: both cases write the same generated registries and dist directory.
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  test('an omitted module contributes no browser code, route, or configuration', () => {
    const full = composeAndBuild('composition.manifest.json');
    // With the module composed, all three legs are present.
    for (const marker of MODULE_MARKERS)
      expect(full.bundle, `full build should contain ${marker}`).toContain(marker);
    // No module identity reaches the bundle even when composed.
    for (const forbidden of FORBIDDEN_BUNDLE_MARKERS)
      expect(full.bundle, `bundle must not disclose module ${forbidden}`).not.toContain(
        forbidden,
      );
    expect(full.registry).toContain('branding-notifications.support-contact');
    expect(full.routes).toContain('branding.support-contact');
    expect(full.routes).toContain('branding.configuration');
    // Support contact is persisted branding state, never a second environment
    // configuration source whose precedence could drift.
    expect(full.config).not.toContain('DUEFOLD_SUPPORT_CONTACT');

    const minimal = composeAndBuild('composition.minimal.manifest.json');
    // With the module omitted, every leg is gone from the built artifact — not
    // present-but-disabled, and not behind a flag.
    for (const marker of MODULE_MARKERS)
      expect(minimal.bundle, `minimal build must not contain ${marker}`).not.toContain(marker);
    expect(minimal.registry).not.toContain('branding-notifications');
    expect(minimal.routes).not.toContain('branding');
    expect(minimal.config).not.toContain('DUEFOLD_SUPPORT_CONTACT');

    // The bundle still exists and is smaller: the client works without the
    // optional module rather than failing to build.
    expect(minimal.bundle.length).toBeGreaterThan(1000);
    expect(minimal.bundle.length).toBeLessThan(full.bundle.length);

    // Restore the default composition for anything that runs afterwards.
    run('node', ['packages/composition/src/cli.ts', 'generate']);
    run('npm', ['run', 'build', '--workspace', '@duefold/web-client']);
  });

  test('the bundle names no runtime module loader or feature flag', () => {
    run('node', ['packages/composition/src/cli.ts', 'generate']);
    run('npm', ['run', 'build', '--workspace', '@duefold/web-client']);
    const bundle = readdirSync(DIST_ASSETS)
      .filter((name) => name.endsWith('.js'))
      .map((name) => readFileSync(resolve(DIST_ASSETS, name), 'utf8'))
      .join('\n');
    // Composition is resolved at build time: nothing discovers or toggles it.
    expect(bundle).not.toMatch(/import\s*\(/u);
    // Anchored on identifier boundaries: React's own `preloadModule` DOM API
    // would otherwise match a bare `loadModule` substring.
    expect(bundle).not.toMatch(/\bfeatureFlag\b|\bisModuleEnabled\b|\bloadModule\b/u);
    // Module composition is absent from product UI.
    expect(bundle).not.toContain('composition.manifest');
    expect(bundle).not.toContain('composedManifest');
  });
});
