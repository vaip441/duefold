import { describe, expect, it } from 'vitest';
import { budgetFiles, parseManifest } from '../../deploy/check-browser-budgets.ts';

describe('browser budget files', () => {
  it('counts every chunk the entry statically imports under initial, except route groups', () => {
    const files = budgetFiles(
      parseManifest({
        'index.html': {
          file: 'assets/index.js',
          name: 'index',
          isEntry: true,
          imports: ['_runtime.js', '_member.js', '_viewer.js'],
        },
        '_runtime.js': { file: 'assets/runtime.js', name: 'rolldown-runtime' },
        '_member.js': {
          file: 'assets/member.js',
          name: 'member',
          imports: ['_runtime.js', '_vendor.js'],
        },
        '_viewer.js': { file: 'assets/viewer.js', name: 'viewer', imports: ['_member.js'] },
        '_vendor.js': { file: 'assets/vendor.js', name: 'vendor' },
      }),
    );
    expect([...files.initial].sort()).toStrictEqual([
      'assets/index.js',
      'assets/runtime.js',
      'assets/vendor.js',
    ]);
    expect([...files.member]).toStrictEqual(['assets/member.js']);
    expect([...files.viewer]).toStrictEqual(['assets/viewer.js']);
  });
});
