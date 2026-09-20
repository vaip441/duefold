import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createClamAvClient, parseVersionLineForTesting } from './scanning/clamav.ts';
import { startClamAvTestEndpoint } from '../../../test/support/clamav-endpoint.ts';
import {
  invokeSandboxed,
  sandboxEnvironmentKeys,
  sandboxProgram,
} from './processing/sandbox.ts';
import {
  createProcessorPrograms,
  processSource,
  processorArgumentsForTesting,
  structuredHttpsLinkForTesting,
} from './processing/formats.ts';
import {
  imageMagickArguments,
  muPdfArguments,
  textMagickArguments,
} from './processing/tool-adapter.ts';
import {
  boundedTmpfsMountForTesting,
  enforceSandboxPreflight,
  formatSandboxPreflight,
  resolveSandboxIsolation,
  type SandboxIsolation,
  SANDBOX_DEGRADED_ACKNOWLEDGEMENT,
  SANDBOX_DEVELOPMENT_ACKNOWLEDGEMENT,
  sandboxPreflight,
} from './processing/preflight.ts';
import {
  assertReleasePolicyIntegrity,
  releaseFormatPolicy,
  releasePolicyDigest,
} from './release-policy.ts';
import { ConverterIdentityPool } from './processing/privilege-separation.ts';

const fixture = new URL(
  '../../../test/fixtures/processors/processor-fixture.mjs',
  import.meta.url,
).pathname;
const networkFixture = new URL(
  '../../../test/fixtures/processors/network-fixture.mjs',
  import.meta.url,
).pathname;
const forkFixture = new URL(
  '../../../test/fixtures/processors/fork-survivor.mjs',
  import.meta.url,
).pathname;
const limits = {
  timeoutMilliseconds: 2_000,
  maximumOutputBytes: 1024 * 1024,
  maximumInputBytes: 1024,
  maximumTemporaryBytes: 1024 * 1024,
};

describe('credential-free sandbox boundary', () => {
  it('constructs an allowlisted environment, removes temporary material, and bounds output/time', async () => {
    process.env['DUEFOLD_DATABASE_URL'] = 'secret-database';
    process.env['AWS_SECRET_ACCESS_KEY'] = 'secret-storage';
    const output = await invokeSandboxed({
      program: sandboxProgram(process.execPath, [fixture]),
      arguments: ['--fixture-inspect'],
      input: Buffer.from('x'),
      limits,
    });
    const inspected = JSON.parse(Buffer.from(output).toString('utf8')) as {
      env: Record<string, string>;
      cwd: string;
    };
    expect(inspected.env).not.toHaveProperty('DUEFOLD_DATABASE_URL');
    expect(inspected.env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(Object.keys(inspected.env).sort()).toEqual(
      [...sandboxEnvironmentKeys(), 'PWD', 'TMPDIR'].sort(),
    );
    expect(inspected.cwd).toContain('duefold-job-');
    /*
     * Assert THIS invocation's own directory was removed. Scanning tmpdir() for
     * any duefold-job- entry absent from a pre-scan is a false positive: the unit
     * project runs files in parallel and every other sandbox test creates its own
     * directory in the same shared tmpdir, so an unrelated concurrent invocation
     * was reported as a leak (reproduced roughly one run in three). The cleanup
     * property is about this sandbox's directory, and the cwd tells us exactly
     * which one that is.
     */
    expect(existsSync(inspected.cwd)).toBe(false);
    await expect(
      invokeSandboxed({
        program: sandboxProgram(process.execPath, [fixture]),
        arguments: ['--fixture-overflow'],
        input: Buffer.from('x'),
        limits: { ...limits, maximumOutputBytes: 10 },
      }),
    ).rejects.toThrow('SANDBOX_OUTPUT_LIMIT');
    await expect(
      invokeSandboxed({
        program: sandboxProgram(process.execPath, [fixture]),
        arguments: ['--fixture-timeout'],
        input: Buffer.from('x'),
        limits: { ...limits, timeoutMilliseconds: 20 },
      }),
    ).rejects.toThrow('SANDBOX_TIMEOUT');
    /* Own-directory assertion; a global scan counts parallel tests as leaks. */
    expect(existsSync(inspected.cwd)).toBe(false);
  });
  it('cannot read host secrets, home files, repository source, or .env outside its allowlist', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'duefold-secret-'));
    const outsideSecret = join(outside, 'recognizable-secret');
    const homeSecret = join(homedir(), `.duefold-sandbox-secret-${String(process.pid)}`);
    await writeFile(outsideSecret, 'OUTSIDE_RECOGNIZABLE_SECRET');
    await writeFile(homeSecret, 'HOME_RECOGNIZABLE_SECRET');
    try {
      const output = await invokeSandboxed({
        program: sandboxProgram(process.execPath, [fixture]),
        arguments: [
          '--fixture-read-paths',
          outsideSecret,
          homeSecret,
          new URL('./processing/formats.ts', import.meta.url).pathname,
          join(process.cwd(), '.env'),
        ],
        input: Buffer.alloc(0),
        limits,
      });
      expect(JSON.parse(Buffer.from(output).toString('utf8'))).toEqual([
        'denied',
        'denied',
        'denied',
        'denied',
      ]);
    } finally {
      await rm(outside, { recursive: true, force: true });
      await rm(homeSecret, { force: true });
    }
  });
  it('kills and reaps a forked survivor before cleanup and prevents outside plaintext writes', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'duefold-sandbox-test-'));
    const scratch = join(testRoot, 'scratch');
    const outsideDirectory = await mkdtemp(join(testRoot, 'outside-'));
    const outsidePath = join(outsideDirectory, 'escaped-plaintext');
    await mkdir(scratch);
    vi.stubEnv('TMPDIR', scratch);
    try {
      await expect(
        invokeSandboxed({
          program: sandboxProgram(process.execPath, [forkFixture]),
          arguments: [outsidePath, 'started'],
          input: Buffer.from('plaintext'),
          limits: { ...limits, timeoutMilliseconds: 50 },
        }),
      ).rejects.toThrow('SANDBOX_TIMEOUT');
      await new Promise((resolve) => setTimeout(resolve, 300));
      await expect(readFile(outsidePath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(
        (await readdir(scratch)).filter((name) => name.startsWith('duefold-job-')),
      ).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      await rm(testRoot, { recursive: true, force: true });
    }
  });
  it('removes scratch after a crashing child', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'duefold-crash-test-'));
    vi.stubEnv('TMPDIR', testRoot);
    try {
      await expect(
        invokeSandboxed({
          program: sandboxProgram(process.execPath, [fixture]),
          arguments: ['--fixture-crash'],
          input: Buffer.from('plaintext'),
          limits,
        }),
      ).rejects.toThrow('SANDBOX_CHILD_FAILED');
      expect(
        (await readdir(testRoot)).filter((name) => name.startsWith('duefold-job-')),
      ).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      await rm(testRoot, { recursive: true, force: true });
    }
  });
  it('uses a network namespace so a child cannot reach a listening local socket', async () => {
    const server = createServer().listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('address missing');
    try {
      const output = await invokeSandboxed({
        program: sandboxProgram(process.execPath, [networkFixture]),
        arguments: [String(address.port)],
        input: Buffer.from(''),
        limits,
      });
      expect(Buffer.from(output).toString()).toBe('denied');
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
  it('reports only a fixed parent-owned workbook stage from a failed adapter', async () => {
    await expect(
      processSource({
        mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        bytes: Buffer.from('not a workbook'),
        programs: createProcessorPrograms({
          pdf: '/bin/false',
          office: '/bin/false',
          image: '/bin/false',
          text: '/bin/false',
        }),
        limits: {
          timeoutMilliseconds: 5_000,
          maximumOutputBytes: 1_024,
          maximumInputBytes: 1_024,
          maximumTemporaryBytes: 1024 * 1024,
        },
      }),
    ).rejects.toThrow('PROCESSOR_REWRITE_FAILED');
  });

  it('accepts only bounded tmpfs mounts at both exact processing paths', () => {
    const mountInfo = [
      '100 1 0:50 / /tmp rw,nosuid - tmpfs tmpfs rw,nosuid,size=262144k',
      '101 1 0:51 / /var/lib/duefold/scratch rw,nosuid - tmpfs tmpfs rw,nosuid,size=2097152k',
      '102 1 0:52 / /tmp-other rw,nosuid - tmpfs tmpfs rw,nosuid,size=1k',
    ].join('\n');
    expect(boundedTmpfsMountForTesting(mountInfo, '/tmp')).toBe(true);
    expect(boundedTmpfsMountForTesting(mountInfo, '/var/lib/duefold/scratch')).toBe(true);
    expect(
      boundedTmpfsMountForTesting(
        '100 1 0:50 / /tmp rw,nosuid - tmpfs tmpfs rw,nosuid',
        '/tmp',
      ),
    ).toBe(false);
    expect(
      boundedTmpfsMountForTesting(
        '100 1 0:50 / /tmp rw,nosuid - ext4 /dev/root rw,size=262144k',
        '/tmp',
      ),
    ).toBe(false);
  });

  it('reports isolation honestly and fails production while allowing only explicit development acknowledgement', async () => {
    const report = await sandboxPreflight();
    expect(report.features.map(({ name }) => name)).toEqual([
      'namespaces',
      'seccomp',
      'cgroups',
      'no-new-privileges',
      'read-only-mounts',
      'bounded-tmpfs',
      'denied-egress',
    ]);
    expect(formatSandboxPreflight(report)).toContain('bounded-tmpfs=absent');
    expect(() => {
      enforceSandboxPreflight(report, 'production');
    }).toThrow('SANDBOX_PREFLIGHT_UNSUPPORTED');
    expect(() => {
      enforceSandboxPreflight(report, 'development', 'yes');
    }).toThrow('SANDBOX_PREFLIGHT_UNSUPPORTED');
    expect(() => {
      enforceSandboxPreflight(report, 'development', SANDBOX_DEVELOPMENT_ACKNOWLEDGEMENT);
    }).not.toThrow();
  });

  /*
   * Degraded isolation exists for hosts whose container runtime denies namespace
   * creation. It is a real reduction in security, so these tests pin both halves:
   * what it must still guarantee, and what it must never do silently.
   *
   * Executing a degraded child requires changing UID, which requires root. These
   * tests therefore split: the gate logic is verified everywhere, while the
   * execution behaviour is verified only where privilege separation is actually
   * available. Skipping is honest; pretending would test a different mode than
   * the one that ships.
   */
  const privileged = process.getuid?.() === 0;

  it('requires an independent typed acknowledgement before degrading isolation', () => {
    expect(resolveSandboxIsolation({ isolation: '' }).mode).toBe('namespaced');
    expect(resolveSandboxIsolation({ isolation: 'namespaced' }).mode).toBe('namespaced');
    // Whitespace is tolerated because a trailing space in a dashboard variable is
    // invisible and failing closed on it would be a baffling outage.
    expect(resolveSandboxIsolation({ isolation: '  namespaced  ' }).mode).toBe('namespaced');
    // The mode alone must not be enough: one variable set while skimming a guide
    // cannot be allowed to remove the parsing boundary.
    expect(() => resolveSandboxIsolation({ isolation: 'degraded' })).toThrow(
      'SANDBOX_DEGRADED_ACKNOWLEDGEMENT_REQUIRED',
    );
    expect(() =>
      resolveSandboxIsolation({ isolation: 'degraded', acknowledgement: 'yes' }),
    ).toThrow('SANDBOX_DEGRADED_ACKNOWLEDGEMENT_REQUIRED');
    // Casing is deliberately NOT normalized: the acknowledgement must be typed as
    // documented, so a near-miss fails rather than quietly counting.
    expect(() =>
      resolveSandboxIsolation({
        isolation: 'degraded',
        acknowledgement: SANDBOX_DEGRADED_ACKNOWLEDGEMENT.toLowerCase(),
      }),
    ).toThrow('SANDBOX_DEGRADED_ACKNOWLEDGEMENT_REQUIRED');
    // An unrecognized value must fail rather than resolve to either boundary.
    expect(() => resolveSandboxIsolation({ isolation: 'none' })).toThrow(
      'SANDBOX_ISOLATION_INVALID',
    );
    const resolve = (): SandboxIsolation =>
      resolveSandboxIsolation({
        isolation: 'degraded',
        acknowledgement: SANDBOX_DEGRADED_ACKNOWLEDGEMENT,
      });
    if (privileged) {
      const resolved = resolve();
      expect(resolved.mode).toBe('degraded');
      // The pool is the capability: invokeSandboxed cannot launch a degraded child
      // without one, so the acknowledgement cannot be skipped by passing a string.
      expect(resolved.mode === 'degraded' && resolved.identities.identities.length).toBe(8);
    } else expect(resolve).toThrow('CONVERTER_PRIVILEGE_UNAVAILABLE');
  });

  it('refuses to launch a degraded child without a converter identity', async () => {
    // The type system already requires the pool, so this covers the runtime guard
    // that stops a cast or a JS caller from reaching the unseparated path.
    await expect(
      invokeSandboxed({
        program: sandboxProgram(process.execPath, [fixture]),
        arguments: ['--fixture-inspect'],
        input: Buffer.from('x'),
        limits,
        mode: 'degraded',
      }),
    ).rejects.toThrow('SANDBOX_DEGRADED_IDENTITY_REQUIRED');
  });

  it('hands out a distinct converter identity per concurrent invocation', async () => {
    const pool = new ConverterIdentityPool(10_200, 2);
    const first = await pool.acquire();
    const second = await pool.acquire();
    // Distinct, because the exit sweep kills every process owned by the identity:
    // a shared uid would let one job's cleanup kill another job's converter.
    expect(first.uid).not.toBe(second.uid);
    let third: { readonly uid: number } | undefined;
    void pool.acquire().then((slot) => {
      third = slot;
    });
    await new Promise((resolve) => setImmediate(resolve));
    // Exhausted pool queues rather than over-issuing, which also bounds how many
    // untrusted converters can run at once.
    expect(third).toBeUndefined();
    pool.release(first);
    await new Promise((resolve) => setImmediate(resolve));
    expect(third?.uid).toBe(first.uid);
  });

  it.runIf(privileged)(
    'confines credentials and bounds resources when isolation is degraded',
    async () => {
      const pool = new ConverterIdentityPool(10_200, 2);
      const output = await invokeSandboxed({
        program: sandboxProgram(process.execPath, [fixture]),
        arguments: ['--fixture-inspect'],
        input: Buffer.from('x'),
        limits,
        mode: 'degraded',
        identities: pool,
      });
      const inspected = JSON.parse(Buffer.from(output).toString('utf8')) as {
        env: Record<string, string>;
        cwd: string;
        uid?: number;
        gid?: number;
        security: Readonly<Record<string, string>>;
      };
      expect(inspected.env).not.toHaveProperty('DUEFOLD_DATABASE_URL');
      expect(Object.keys(inspected.env).sort()).toEqual(
        [...sandboxEnvironmentKeys(), 'TMPDIR'].sort(),
      );
      // The uid MUST differ from the service user. This is the property that stops
      // the converter reading the service's /proc/<pid>/environ, which an earlier
      // version of this mode failed to provide while claiming it did.
      expect(inspected.uid).not.toBe(process.getuid?.());
      expect(inspected.gid).toBe(inspected.uid);
      expect(inspected.security).toMatchObject({
        CapEff: '0000000000000000',
        CapBnd: '0000000000000000',
        NoNewPrivs: '1',
      });
      expect(inspected.cwd).toContain('duefold-job-');
      expect(existsSync(inspected.cwd)).toBe(false);
      await expect(
        invokeSandboxed({
          program: sandboxProgram(process.execPath, [fixture]),
          arguments: ['--fixture-overflow'],
          input: Buffer.from('x'),
          limits: { ...limits, maximumOutputBytes: 10 },
          mode: 'degraded',
          identities: pool,
        }),
      ).rejects.toThrow('SANDBOX_OUTPUT_LIMIT');
      await expect(
        invokeSandboxed({
          program: sandboxProgram(process.execPath, [fixture]),
          arguments: ['--fixture-timeout'],
          input: Buffer.from('x'),
          limits: { ...limits, timeoutMilliseconds: 20 },
          mode: 'degraded',
          identities: pool,
        }),
      ).rejects.toThrow('SANDBOX_TIMEOUT');
    },
  );

  it.runIf(privileged)(
    'denies a degraded converter the service process environment',
    async () => {
      // The regression test for the critical defect: scrubbing the child's own
      // environment is worthless if it can read the parent's environ, which is an
      // exec-time snapshot no in-process deletion can remove.
      const pool = new ConverterIdentityPool(10_200, 1);
      const output = await invokeSandboxed({
        program: sandboxProgram(process.execPath, [fixture]),
        arguments: ['--fixture-read-paths', `/proc/${String(process.pid)}/environ`],
        input: Buffer.from('x'),
        limits,
        mode: 'degraded',
        identities: pool,
      });
      expect(JSON.parse(Buffer.from(output).toString('utf8'))).toEqual(['denied']);
    },
  );

  it.runIf(privileged)(
    'kills a degraded descendant that escapes its process group',
    async () => {
      // setsid escapes the process group, so the uid sweep is what bounds a
      // malicious converter. Without it the survivor outlives its own timeout and
      // keeps writing, which is what the earlier implementation allowed.
      const outside = await mkdtemp(join(tmpdir(), 'duefold-survivor-'));
      const escaped = join(outside, 'escaped');
      const pool = new ConverterIdentityPool(10_200, 1);
      try {
        await expect(
          invokeSandboxed({
            program: sandboxProgram(process.execPath, [forkFixture, escaped, 'MARK']),
            arguments: [],
            input: Buffer.from('x'),
            limits: { ...limits, timeoutMilliseconds: 300 },
            mode: 'degraded',
            identities: pool,
          }),
        ).rejects.toThrow(/SANDBOX_/u);
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        expect(existsSync(escaped)).toBe(false);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    },
  );

  it.runIf(privileged)(
    'exposes the host filesystem in degraded mode, unlike the namespaced boundary',
    async () => {
      const outside = await mkdtemp(join(tmpdir(), 'duefold-degraded-'));
      const outsideSecret = join(outside, 'recognizable-secret');
      await writeFile(outsideSecret, 'OUTSIDE_RECOGNIZABLE_SECRET');
      // World-readable, so this measures the absence of filesystem isolation
      // rather than the uid separation already covered above.
      await chmod(outside, 0o755);
      await chmod(outsideSecret, 0o644);
      const pool = new ConverterIdentityPool(10_200, 1);
      try {
        const read = async (isolation: SandboxIsolation): Promise<readonly string[]> =>
          JSON.parse(
            Buffer.from(
              await invokeSandboxed({
                program: sandboxProgram(process.execPath, [fixture]),
                arguments: ['--fixture-read-paths', outsideSecret],
                input: Buffer.from('x'),
                limits,
                ...(isolation.mode === 'namespaced'
                  ? {}
                  : { mode: isolation.mode, identities: isolation.identities }),
              }),
            ).toString('utf8'),
          ) as readonly string[];
        // The asymmetry is the cost of the mode, asserted so it can never be
        // described as equivalent to the namespaced boundary.
        expect(await read({ mode: 'namespaced' })).toEqual(['denied']);
        expect(await read({ mode: 'degraded', identities: pool })).toEqual(['readable']);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    },
  );
});

describe('ClamAV INSTREAM', () => {
  it('parses the VERSION line clamd actually sends', () => {
    /*
     * Verbatim from clamav/clamav-debian:1.5 answering zVERSION, captured on a
     * deployed service. The separator after the product name is a SPACE. The
     * parser previously required `ClamAV/`, which no clamd emits, so readiness
     * reported the scanner unavailable and no document could ever be published —
     * and because the socket double echoed the same fictional shape, the whole
     * suite passed. This asserts against the real string, not the double.
     */
    const parsed = parseVersionLineForTesting('ClamAV 1.5.4/28129/Mon Sep 14 06:24:19 2026');
    expect(parsed.signatureVersion).toBe('28129');
    // clamd emits no timezone, so the instant is only well defined against the
    // process zone; assert the calendar fields rather than a fixed UTC instant,
    // which would make this test pass only in one timezone. Deployed services and
    // the clamav container both run UTC, so they agree in practice.
    expect([
      parsed.date.getFullYear(),
      parsed.date.getMonth(),
      parsed.date.getDate(),
      parsed.date.getHours(),
      parsed.date.getMinutes(),
      parsed.date.getSeconds(),
    ]).toEqual([2026, 8, 14, 6, 24, 19]);
    // An explicit zone, which is what the socket double sends, is exact.
    expect(
      parseVersionLineForTesting(
        'ClamAV 1.5.4/28129/Mon, 14 Sep 2026 06:24:19 GMT',
      ).date.toISOString(),
    ).toBe('2026-09-14T06:24:19.000Z');
    // `clamd --version` and some wrappers keep the slash; both are accepted.
    expect(
      parseVersionLineForTesting('ClamAV/1.5.4/28129/Mon Sep 14 06:24:19 2026')
        .signatureVersion,
    ).toBe('28129');
    // Anything else still fails closed rather than scanning with an unknown build.
    for (const line of ['ClamAV', 'ClamAV 1.5.4', 'ClamAV 1.5.4/28129', 'nonsense'])
      expect(() => parseVersionLineForTesting(line)).toThrow('SCANNER_RESPONSE_MALFORMED');
    expect(() => parseVersionLineForTesting('ClamAV 1.5.4/28129/not a date')).toThrow(
      'SCANNER_RESPONSE_MALFORMED',
    );
  });
  it('speaks the real framed socket protocol and enforces freshness', async () => {
    const endpoint = await startClamAvTestEndpoint({
      signatureDate: new Date(),
      response: 'clean',
    });
    try {
      await expect(
        createClamAvClient({ socket: endpoint, timeoutMilliseconds: 500 }).scan(
          Buffer.from('hello'),
        ),
      ).resolves.toMatchObject({ result: 'clean' });
      const stream = endpoint.requests()[1];
      expect(
        Buffer.from(stream ?? [])
          .subarray(0, 10)
          .toString(),
      ).toBe('zINSTREAM\0');
    } finally {
      await endpoint.close();
    }
    const stale = await startClamAvTestEndpoint({ signatureDate: new Date(0) });
    try {
      await expect(
        createClamAvClient({ socket: stale, timeoutMilliseconds: 500 }).scan(Buffer.from('x')),
      ).rejects.toThrow('SCANNER_SIGNATURES_STALE');
    } finally {
      await stale.close();
    }
  });
  it('supports detached scan invocation without relying on a method receiver', async () => {
    const endpoint = await startClamAvTestEndpoint({
      signatureDate: new Date(),
      response: 'clean',
    });
    try {
      const { scan } = createClamAvClient({ socket: endpoint, timeoutMilliseconds: 500 });
      await expect(scan(Buffer.from('detached'))).resolves.toMatchObject({ result: 'clean' });
    } finally {
      await endpoint.close();
    }
  });

  it('fails closed on malware, errors, malformed replies, outage, and timeout', async () => {
    for (const response of ['malware', 'error', 'malformed'] as const) {
      const endpoint = await startClamAvTestEndpoint({ signatureDate: new Date(), response });
      try {
        const promise = createClamAvClient({ socket: endpoint, timeoutMilliseconds: 100 }).scan(
          Buffer.from('x'),
        );
        if (response === 'malware')
          await expect(promise).resolves.toMatchObject({ result: 'malware' });
        else await expect(promise).rejects.toThrow();
      } finally {
        await endpoint.close();
      }
    }
    const closedServer = createServer().listen(0, '127.0.0.1');
    await once(closedServer, 'listening');
    const closedAddress = closedServer.address();
    if (closedAddress === null || typeof closedAddress === 'string')
      throw new Error('address missing');
    const closedPort = closedAddress.port;
    closedServer.close();
    await once(closedServer, 'close');
    await expect(
      createClamAvClient({
        socket: { host: '127.0.0.1', port: closedPort },
        timeoutMilliseconds: 50,
      }).scan(Buffer.from('x')),
    ).rejects.toThrow('SCANNER_UNAVAILABLE');
    const stalled = await startClamAvTestEndpoint({ signatureDate: new Date(), stall: true });
    try {
      await expect(
        createClamAvClient({ socket: stalled, timeoutMilliseconds: 20 }).scan(Buffer.from('x')),
      ).rejects.toThrow('SCANNER_TIMEOUT');
    } finally {
      await stalled.close();
    }
    for (const disconnectDuring of ['version', 'instream'] as const) {
      const disconnected = await startClamAvTestEndpoint({
        signatureDate: new Date(),
        disconnectDuring,
      });
      try {
        await expect(
          createClamAvClient({ socket: disconnected, timeoutMilliseconds: 100 }).scan(
            Buffer.from('x'),
          ),
        ).rejects.toThrow();
      } finally {
        await disconnected.close();
      }
    }
  });
});

describe('real tool adapters', () => {
  it('constructs exact MuPDF 1.25 and ImageMagick 7 vectors', () => {
    expect(muPdfArguments('/scratch/source.pdf')).toEqual([
      'draw',
      '-F',
      'png',
      '-o',
      'page-%04d.png',
      '-r',
      '144',
      '-A',
      '8',
      '/scratch/source.pdf',
    ]);
    expect(imageMagickArguments('/scratch/source')).toEqual([
      '/scratch/source[0]',
      '-auto-orient',
      '-strip',
      'page-0001.png',
    ]);
    expect(textMagickArguments()).toEqual([
      '-background',
      'white',
      '-fill',
      'black',
      '-font',
      '/usr/share/fonts/truetype/noto/NotoSansMono-Regular.ttf',
      '-pointsize',
      '16',
      '-size',
      '1200x',
      'caption:@-',
      '-strip',
      'page-0001.png',
    ]);
  });
});

describe('format processing contracts', () => {
  it('enables workbook conversion only through the structural adapter modes', () => {
    expect(
      processorArgumentsForTesting(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ),
    ).toEqual(['xlsx']);
    expect(
      processorArgumentsForTesting('application/vnd.oasis.opendocument.spreadsheet'),
    ).toEqual(['ods']);
  });
  it('sanitizes child text output', async () => {
    const program = sandboxProgram(process.execPath, [fixture]);
    const unsafe = await processSource({
      mediaType: 'text/plain',
      bytes: Buffer.from('x'),
      programs: {
        pdf: program,
        office: program,
        image: program,
        text: sandboxProgram(process.execPath, [fixture, '--fixture-unsafe-text']),
      },
    });
    expect(unsafe.pages[0]?.textLayer).toBeUndefined();
    expect(unsafe.pages[0]?.accessibleLabel).toBe('Page 1');
  });
  it.each([
    '<div>x</div>',
    '<a href=x>x</a>',
    '<table><tr><td>x</td></tr></table>',
    '</script>',
    '<!-- c -->',
    '<!-- prefix --><section>x</section>',
    '<div\nclass=x>x</div>',
  ])('omits markup-like extracted text without rejecting the page: %s', async (value) => {
    const base = sandboxProgram(process.execPath, [fixture]);
    const result = await processSource({
      mediaType: 'application/pdf',
      bytes: Buffer.from('%PDF-1.7'),
      programs: {
        pdf: sandboxProgram(process.execPath, [fixture, `--fixture-text=${value}`]),
        office: base,
        image: base,
        text: base,
      },
    });
    expect(result.pages[0]?.textLayer).toBeUndefined();
    expect(result.pages[0]?.accessibleLabel).toBe('Page 1');
  });
  it.each(['Data: Q1 revenue', 'Revenue < $10m'])(
    'preserves ordinary extracted prose: %s',
    async (value) => {
      const base = sandboxProgram(process.execPath, [fixture]);
      const result = await processSource({
        mediaType: 'application/pdf',
        bytes: Buffer.from('%PDF-1.7'),
        programs: {
          pdf: sandboxProgram(process.execPath, [fixture, `--fixture-text=${value}`]),
          office: base,
          image: base,
          text: base,
        },
      });
      expect(result.pages[0]?.textLayer?.[0]?.text).toBe(value);
    },
  );
  it('emits only structured credential-free HTTPS links', () => {
    expect(structuredHttpsLinkForTesting('https://example.com/path')).toBe(
      'https://example.com/path',
    );
    expect(structuredHttpsLinkForTesting('javascript:alert(1)')).toBeUndefined();
    expect(structuredHttpsLinkForTesting('data:text/html,x')).toBeUndefined();
    expect(structuredHttpsLinkForTesting('http://example.com')).toBeUndefined();
    expect(structuredHttpsLinkForTesting('https://user:pass@example.com')).toBeUndefined();
  });
  it('makes formula-like CSV cells inert through explicit deterministic arguments', () => {
    expect(processorArgumentsForTesting('text/csv')).toEqual(
      expect.arrayContaining([
        '--non-html',
        '--formula-cells=inert-text',
        '--max-rows',
        '100000',
        '--max-columns',
        '1000',
      ]),
    );
  });
});

describe('release format policy', () => {
  it('canonicalizes key order and fails integrity on semantic change', () => {
    assertReleasePolicyIntegrity();
    const reversed = Object.fromEntries(
      Object.entries(releaseFormatPolicy).reverse(),
    ) as typeof releaseFormatPolicy;
    expect(releasePolicyDigest(reversed)).toBe(releasePolicyDigest(releaseFormatPolicy));
    // XLSX/ODS stay disabled until the structural workbook adapter is qualified.
    // This assertion follows the policy, never the reverse.
    expect(
      releaseFormatPolicy['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
        .enabledForNewWork,
    ).toBe(false);
    expect(
      releaseFormatPolicy['application/vnd.oasis.opendocument.spreadsheet'].enabledForNewWork,
    ).toBe(false);
    const changed = {
      ...releaseFormatPolicy,
      'application/pdf': { enabledForNewWork: false, existingDerivativesSafe: true },
    };
    expect(releasePolicyDigest(changed)).not.toBe(releasePolicyDigest(releaseFormatPolicy));
    expect(() => {
      assertReleasePolicyIntegrity(changed);
    }).toThrow('RELEASE_POLICY_INTEGRITY_FAILED');
  });
});
