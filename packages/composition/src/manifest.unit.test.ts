import { describe, expect, it } from 'vitest';
import type { CompositionManifest, JobDeclaration, ModuleDeclaration } from './contract.ts';
import { validateDeclarations } from './manifest.ts';

const manifest: CompositionManifest = {
  version: 1,
  modules: ['core-security'],
  adapters: { storage: 's3-compatible', mail: 'smtp', identity: 'oidc' },
};

function withJob(job: Partial<JobDeclaration>): readonly ModuleDeclaration[] {
  return [
    {
      id: 'core-security',
      packageName: '@duefold/core-security',
      routes: [],
      migrations: [],
      jobs: [
        {
          id: 'test.job',
          handler: 'jobs/test.ts',
          handlerFactoryExport: 'createHandler',
          service: 'worker',
          ...job,
        },
      ],
      config: [],
      browserEntries: [],
      requires: [],
    },
  ];
}

describe('job declarations', () => {
  it('accept a positive whole-second schedule and a lowercase hook name', () => {
    expect(() => {
      validateDeclarations(
        manifest,
        withJob({ everySeconds: 300, onExhausted: 'fail_exhausted_test_job' }),
      );
    }).not.toThrow();
  });

  it.each([0, -60, 1.5, Number.NaN])('refuse everySeconds %s', (everySeconds) => {
    expect(() => {
      validateDeclarations(manifest, withJob({ everySeconds }));
    }).toThrow('job test.job: everySeconds must be a positive integer');
  });

  it.each([
    'Fail_Exhausted',
    'public.fail_exhausted',
    'fail-exhausted',
    '1fail',
    '',
    'f'.repeat(64),
  ])('refuse hook %j', (onExhausted) => {
    expect(() => {
      validateDeclarations(manifest, withJob({ onExhausted }));
    }).toThrow('job test.job: onExhausted must be a lowercase SQL function name');
  });
});
