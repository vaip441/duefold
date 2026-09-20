import { describe, expect, it, vi } from 'vitest';
import { runCli } from './main.ts';

const FEATURES = [
  'namespaces',
  'seccomp',
  'cgroups',
  'no-new-privileges',
  'read-only-mounts',
  'bounded-tmpfs',
  'denied-egress',
] as const;

describe('preflight sandbox', () => {
  /**
   * The command exists to evaluate a candidate host before any credential or
   * document reaches it, so it must run with no configuration, no database, and
   * whatever unrelated DUEFOLD_* variables the platform already injected. A
   * stray key is included deliberately: a host being evaluated is usually
   * half-configured, and a strict unknown-key rejection here would make the
   * command unusable exactly when it is needed.
   */
  it('reports every isolation feature with no configuration and an unrelated variable present', async () => {
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const previousExitCode = process.exitCode;
    let observedExitCode: number | string | undefined;
    try {
      process.exitCode = undefined;
      await runCli(['preflight', 'sandbox'], { DUEFOLD_PUBLIC_URL: 'https://duefold.example' });
      observedExitCode = process.exitCode;
    } finally {
      log.mockRestore();
      process.exitCode = previousExitCode;
    }
    const output = lines.join('\n');
    for (const feature of FEATURES)
      expect(output).toMatch(new RegExp(`^${feature}=(?:present|absent)$`, 'mu'));
    const supported = /^supported=(true|false)$/mu.exec(output)?.[1];
    expect(supported).toBeDefined();
    // Host-independent: an honest report of an unsupported sandbox must still
    // fail a deployment gate, and a supported one must not.
    expect(observedExitCode).toBe(supported === 'false' ? 1 : undefined);
  });

  it('rejects a preflight invocation that is not the sandbox report', async () => {
    await expect(runCli(['preflight'], {})).rejects.toThrow('usage:');
    await expect(runCli(['preflight', 'sandbox', 'extra'], {})).rejects.toThrow('usage:');
  });
});
