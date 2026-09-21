import { existsSync, readFileSync } from 'node:fs';
import { dirname, normalize, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const maps = [
  'CODEBASE_MAP.md',
  'modules/core-security/README.md',
  'modules/rooms-documents/README.md',
  'modules/participants-access/README.md',
  'modules/branding-notifications/README.md',
] as const;

function localTargets(markdownPath: string): readonly string[] {
  const source = readFileSync(markdownPath, 'utf8');
  return [...source.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)]
    .map((match) => match[1] ?? '')
    .filter(
      (target) =>
        target !== '' &&
        !target.startsWith('#') &&
        !target.startsWith('http://') &&
        !target.startsWith('https://') &&
        !target.startsWith('mailto:'),
    )
    .map((target) => decodeURIComponent(target.split('#', 1)[0] ?? ''));
}

describe('codebase maps', () => {
  it('link only to paths that exist', () => {
    const missing = maps.flatMap((map) =>
      localTargets(map)
        .map((target) => normalize(resolve(dirname(map), target)))
        .filter((target) => !existsSync(target))
        .map((target) => `${map} -> ${target}`),
    );

    expect(missing).toStrictEqual([]);
  });
});
