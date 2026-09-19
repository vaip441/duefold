import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Guards the type-check surface itself.
 *
 * The repository has THREE TypeScript projects, and the root one deliberately
 * excludes `apps/web-client` and `test/browser` because they need DOM libs and JSX.
 * Running `tsc -p tsconfig.json` alone therefore reports success while every React
 * component, hook, and browser spec goes unchecked -- which is exactly what happened:
 * a commit landed with seven type errors in client code, including a state shape that
 * could not compile, because only the root project had been run.
 *
 * `npm run typecheck` covers all three. This test asserts that, so the composite
 * command cannot quietly lose a project and leave a whole app unchecked again.
 */
describe('type-check surface', () => {
  const scripts = (
    JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Readonly<Record<string, string>>;
    }
  ).scripts;

  it('covers every TypeScript project, not just the root one', () => {
    const typecheck = scripts['typecheck'] ?? '';
    for (const project of [
      'tsconfig.json',
      'apps/web-client/tsconfig.json',
      'test/browser/tsconfig.json',
    ])
      expect(typecheck, project).toContain(`tsc -p ${project}`);
  });

  it('keeps the client and browser projects out of the root project, and covered elsewhere', () => {
    /*
     * If the root project ever started including the client sources it would fail on
     * missing DOM types rather than silently skipping them, so this asserts the
     * split is deliberate rather than accidental.
     */
    const root = JSON.parse(readFileSync('tsconfig.json', 'utf8')) as {
      include: readonly string[];
      exclude: readonly string[];
    };
    expect(root.include.some((entry) => entry.includes('web-client'))).toBe(false);
    expect(root.exclude).toContain('test/browser/**');
  });

  it('reports errors in client code, proving that project is really checked', () => {
    /*
     * A tautological version of this test would assert the command string only. This
     * runs the client project and requires a clean result, so a regression in a
     * component is a failing test rather than a silent pass.
     */
    expect(() =>
      execFileSync('npx', ['tsc', '-p', 'apps/web-client/tsconfig.json'], {
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    ).not.toThrow();
  }, 120_000);
});
