import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The module/application boundary, asserted rather than trusted.
 *
 * A module's browser code used to import eight separate application paths, each export
 * added so one module would compile. The application therefore had no way to tell which
 * of its internals a module depended on, and refactoring any of them silently broke an
 * OPTIONAL module — a breakage a minimal composition would not even surface.
 *
 * `apps/web-client/src/module-api.ts` is now the whole contract. This fails if a module
 * reaches past it, so the coupling cannot quietly grow back one import at a time.
 */
describe('first-party modules import only the module API', () => {
  it('names no other web-client path', () => {
    const offenders = globSync('modules/*/src/**/*.{ts,tsx}')
      .map((path) => ({ path, source: readFileSync(path, 'utf8') }))
      .flatMap(({ path, source }) =>
        [...source.matchAll(/from '(@duefold\/web-client\/[^']+)'/gu)]
          .map((match) => match[1])
          .filter((specifier) => specifier !== '@duefold/web-client/module-api')
          .map((specifier) => `${path} -> ${specifier ?? ''}`),
      );
    expect(offenders).toStrictEqual([]);
  });

  /*
   * A RELATIVE PATH IS THE SAME COUPLING WITH A DIFFERENT SPELLING.
   *
   * The package-specifier check above is satisfied by
   * `../../../apps/web-client/src/workspace/state.ts`, which reaches exactly as far into the
   * application and is harder to notice in review. Both spellings are refused, so the entry
   * point cannot be bypassed by writing the path out longhand.
   *
   * `apps/web/` is deliberately NOT covered: a module's SERVER code is composed into the web
   * app and legitimately imports its runtime and route types. What this guards is the
   * BROWSER boundary, where an omitted module must contribute no code at all.
   */
  it('does not reach into the web client by relative path either', () => {
    const offenders = globSync('modules/*/src/**/*.{ts,tsx}')
      .map((path) => ({ path, source: readFileSync(path, 'utf8') }))
      .flatMap(({ path, source }) =>
        [...source.matchAll(/from '([^']*apps\/web-client\/[^']*)'/gu)].map(
          (match) => `${path} -> ${match[1] ?? ''}`,
        ),
      );
    expect(offenders).toStrictEqual([]);
  });

  it('exposes exactly one module-facing entry in package exports', () => {
    const manifest = JSON.parse(readFileSync('apps/web-client/package.json', 'utf8')) as {
      readonly exports: Readonly<Record<string, string>>;
    };
    /* `contract` stays separate: it is the type-only shape the build plugin and the
       registry share, and it carries no runtime code. */
    expect(Object.keys(manifest.exports).sort()).toStrictEqual(['./contract', './module-api']);
  });
});
