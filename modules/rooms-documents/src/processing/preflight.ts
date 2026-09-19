import { readFile } from 'node:fs/promises';
import { invokeSandboxed, sandboxProgram } from './sandbox.ts';

export const SANDBOX_DEVELOPMENT_ACKNOWLEDGEMENT =
  'I_ACKNOWLEDGE_DUEFOLD_SANDBOX_IS_NOT_PRODUCTION_SAFE';
export interface IsolationFeature {
  readonly name:
    | 'namespaces'
    | 'seccomp'
    | 'cgroups'
    | 'no-new-privileges'
    | 'read-only-mounts'
    | 'bounded-tmpfs'
    | 'denied-egress';
  readonly present: boolean;
}
export interface SandboxPreflightReport {
  readonly supported: boolean;
  readonly features: readonly IsolationFeature[];
}
async function read(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return undefined;
  }
}
async function isolationProbe(): Promise<boolean> {
  try {
    const output = await invokeSandboxed({
      program: sandboxProgram('/bin/sh'),
      arguments: [
        '-c',
        'test "$$" = 2 && ! test -e /proc && ! test -e /home && ! test -e /root && ! test -e /etc/passwd',
      ],
      input: Buffer.alloc(0),
      limits: {
        timeoutMilliseconds: 2_000,
        maximumOutputBytes: 1024,
        maximumInputBytes: 1,
        maximumTemporaryBytes: 1024,
      },
    });
    return output.length === 0;
  } catch {
    return false;
  }
}
function finiteLimit(value: string | undefined): boolean {
  if (value === undefined || value === '' || value === 'max') return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0;
}
function boundedSize(value: string | undefined): boolean {
  if (value === undefined) return false;
  const match = /^(\d+)([kmgt]?)$/iu.exec(value);
  if (match === null) return false;
  const amount = Number(match[1]);
  return Number.isSafeInteger(amount) && amount > 0;
}
function decodeMountPath(value: string): string {
  return value.replace(/\\([0-7]{3})/gu, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}
function boundedTmpfsMount(mountInfo: string, target: string): boolean {
  return mountInfo.split('\n').some((line) => {
    const [mount, filesystem] = line.split(' - ');
    if (mount === undefined || filesystem === undefined) return false;
    const mountFields = mount.split(' ');
    const filesystemFields = filesystem.split(' ');
    if (decodeMountPath(mountFields[4] ?? '') !== target || filesystemFields[0] !== 'tmpfs')
      return false;
    const options = new Set((filesystemFields[2] ?? '').split(','));
    const size = [...options].find((option) => option.startsWith('size='))?.slice(5);
    return boundedSize(size);
  });
}
async function boundedTemporaryMounts(): Promise<boolean> {
  const mountInfo = await read('/proc/self/mountinfo');
  if (mountInfo === undefined) return false;
  return (
    boundedTmpfsMount(mountInfo, '/tmp') &&
    boundedTmpfsMount(mountInfo, '/var/lib/duefold/scratch')
  );
}
async function effectiveCgroups(): Promise<boolean> {
  const membership = await read('/proc/self/cgroup');
  if (membership?.split('\n').some((line) => line.startsWith('0::/')) !== true) return false;
  const memory = await read('/sys/fs/cgroup/memory.max');
  const pids = await read('/sys/fs/cgroup/pids.max');
  const cpu = await read('/sys/fs/cgroup/cpu.max');
  if (!finiteLimit(memory) || !finiteLimit(pids) || cpu === undefined) return false;
  const [quota, period] = cpu.split(/\s+/u);
  return quota !== 'max' && finiteLimit(quota) && finiteLimit(period);
}

/** Runs the actual child isolation boundary and inspects effective cgroup
 * membership/limits. The target must be PID 2 behind bubblewrap's namespace
 * reaper, and setpriv makes no-new-privileges a mandatory transition before exec.
 * It never infers enforcement from executable or file existence. Production
 * environments must additionally provide bounded tmpfs and cgroups. */
export async function sandboxPreflight(): Promise<SandboxPreflightReport> {
  const boundary = await isolationProbe();
  const status = await read('/proc/self/status');
  const seccomp = /^Seccomp:\s*2$/mu.test(status ?? '');
  const features: readonly IsolationFeature[] = [
    { name: 'namespaces', present: boundary },
    { name: 'seccomp', present: seccomp },
    { name: 'cgroups', present: await effectiveCgroups() },
    { name: 'no-new-privileges', present: boundary },
    { name: 'read-only-mounts', present: boundary },
    { name: 'bounded-tmpfs', present: await boundedTemporaryMounts() },
    { name: 'denied-egress', present: boundary },
  ];
  return { supported: features.every(({ present }) => present), features };
}
export function formatSandboxPreflight(report: SandboxPreflightReport): string {
  return report.features
    .map(({ name, present }) => `${name}=${present ? 'present' : 'absent'}`)
    .join('\n');
}
export const boundedTmpfsMountForTesting = boundedTmpfsMount;
export function enforceSandboxPreflight(
  report: SandboxPreflightReport,
  mode: 'production' | 'development',
  acknowledgement?: string,
): void {
  if (report.supported) return;
  if (mode === 'development' && acknowledgement === SANDBOX_DEVELOPMENT_ACKNOWLEDGEMENT) return;
  throw new Error('SANDBOX_PREFLIGHT_UNSUPPORTED');
}
