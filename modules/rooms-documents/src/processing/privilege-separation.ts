import { spawnSync } from 'node:child_process';
import { chown, readdir, readFile } from 'node:fs/promises';

/**
 * Privilege separation for the degraded launch mode.
 *
 * Degraded mode exists for hosts whose container runtime denies namespace
 * creation, where bubblewrap cannot run. Without a namespace, two properties
 * that the namespaced boundary gets for free must be rebuilt from UNIX
 * primitives, because an earlier version of this mode claimed both and had
 * neither:
 *
 * 1. CREDENTIAL CONFINEMENT. `/proc/<pid>/environ` is mode 0400 owned by the
 *    process UID, and it is a snapshot of the environment as it was at exec
 *    time. A process therefore cannot hide its own secrets by deleting them
 *    from `process.env`: the kernel keeps reading the original memory range.
 *    A converter running as the SAME user as the service can simply read the
 *    service's environ and recover the database URL, storage keys, OIDC
 *    secret, and every HMAC key. Scrubbing the child's environment does not
 *    help, because the child does not need its own environment to read the
 *    parent's. The only portable fix is to run the converter as a DIFFERENT,
 *    unprivileged UID, which makes the service's environ unreadable to it.
 *
 *    Verified cross-UID against a process owned by another user: `environ`
 *    (0400), `maps` (0444 but ptrace-gated), and the `fd` table (0500) all
 *    return EACCES. `cmdline`, `status`, and `mountinfo` remain readable, so no
 *    secret may ever be passed as a command-line argument to a service process;
 *    both entry points take configuration from the environment only.
 *
 * 2. DESCENDANT CONTAINMENT. Killing the child's process group does not stop a
 *    descendant that called `setsid`, and `--die-with-parent` is a bubblewrap
 *    feature. A converter can therefore outlive its own timeout. But a process
 *    that is unprivileged and runs under `--no-new-privs` cannot change its
 *    own UID, so sweeping every process owned by the converter UID is a bound
 *    it cannot escape. That is why the UID is per-invocation rather than
 *    shared: a shared UID would make one job's sweep kill another job's
 *    converter.
 *
 * Both require the service process to be able to change UID, which means root
 * or CAP_SETUID. That is checked explicitly at startup rather than discovered
 * when the first document arrives.
 */

/** Distinct UID per concurrent invocation, so a sweep never crosses jobs. */
export const CONVERTER_UID_COUNT = 8;

/*
 * SCOPE LIMIT: the sweep selects processes by UID, and the pool that reserves
 * those UIDs lives in one process. Two service processes sharing a UID range on
 * the same kernel would therefore sweep each other's converters, killing healthy
 * jobs. That is safe in the deployments this mode targets, where each container
 * is its own PID and user space and replicas do not share a kernel namespace,
 * but it is not safe for two workers started side by side on one host. Such a
 * deployment must give each process a distinct base UID.
 */
const SLOT_TOKEN: unique symbol = Symbol('duefold.converter-slot');

export interface ConverterSlot {
  readonly uid: number;
  readonly gid: number;
  readonly [SLOT_TOKEN]: true;
}

/**
 * Fixed-size pool of converter identities.
 *
 * Doubles as a concurrency limit on untrusted parsing, which is deliberate: the
 * watermark path is reached once per protected page view, so an unbounded number
 * of simultaneous converters would be a denial-of-service surface even with
 * perfect isolation.
 */
export class ConverterIdentityPool {
  readonly #base: number;
  readonly #available: number[];
  readonly #waiting: ((slot: ConverterSlot) => void)[] = [];

  public constructor(baseUid: number, count: number = CONVERTER_UID_COUNT) {
    if (!Number.isSafeInteger(baseUid) || baseUid <= 0)
      throw new Error('CONVERTER_UID_BASE_INVALID');
    if (!Number.isSafeInteger(count) || count < 1)
      throw new Error('CONVERTER_UID_COUNT_INVALID');
    this.#base = baseUid;
    this.#available = Array.from({ length: count }, (_value, index) => baseUid + index);
  }

  public get identities(): readonly number[] {
    return this.#available.length === 0 ? [] : [...this.#available];
  }

  public get base(): number {
    return this.#base;
  }

  public async acquire(): Promise<ConverterSlot> {
    const uid = this.#available.pop();
    if (uid !== undefined) return { uid, gid: uid, [SLOT_TOKEN]: true };
    return new Promise<ConverterSlot>((resolve) => {
      this.#waiting.push(resolve);
    });
  }

  public release(slot: ConverterSlot): void {
    const next = this.#waiting.shift();
    if (next !== undefined) next(slot);
    else this.#available.push(slot.uid);
  }
}

/**
 * Proves the process can actually change UID before any document is accepted.
 *
 * Failing here is the point. A deployment that cannot drop privileges would
 * otherwise run converters as the service user, which is exactly the
 * configuration that leaks credentials through `/proc`.
 */
export function assertPrivilegeSeparationAvailable(probeUid: number): void {
  if (process.getuid?.() !== 0) throw new Error('CONVERTER_PRIVILEGE_UNAVAILABLE');
  // Root alone is not proof: a container may drop CAP_SETUID/CAP_SETGID or a
  // seccomp profile may deny the transition. Exercise the exact setpriv
  // primitives at startup without exposing the service environment.
  const probe = spawnSync(
    '/usr/bin/setpriv',
    [
      '--no-new-privs',
      '--bounding-set=-all',
      '--inh-caps=-all',
      '--ambient-caps=-all',
      `--reuid=${String(probeUid)}`,
      `--regid=${String(probeUid)}`,
      '--clear-groups',
      '--',
      '/usr/bin/id',
      '-u',
    ],
    {
      encoding: 'utf8',
      env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: '/usr/bin:/bin' },
      timeout: 2_000,
    },
  );
  if (probe.status !== 0 || probe.stdout.trim() !== String(probeUid))
    throw new Error('CONVERTER_PRIVILEGE_UNAVAILABLE');
}

/** Hands the per-invocation scratch directory to the converter identity. The
 * parent keeps ownership of the parent directory, so it can still remove the
 * tree afterwards regardless of what the child created inside it. */
export async function grantScratch(directory: string, slot: ConverterSlot): Promise<void> {
  await chown(directory, slot.uid, slot.gid);
}

/**
 * Kills every surviving process owned by the converter identity.
 *
 * This is the containment a PID namespace would have provided. It is
 * inescapable for the converter because an unprivileged `--no-new-privs`
 * process cannot change its own UID, so it cannot leave the set being swept —
 * unlike a process group, which `setsid` escapes.
 */
export async function sweepConverterProcesses(slot: ConverterSlot): Promise<number> {
  let killed = 0;
  // A single /proc snapshot has a fork race: a process already visited can fork
  // a child whose PID sorts before the current cursor, then die when signalled,
  // leaving the new child unseen. Keep taking snapshots until a complete pass
  // finds no process with this real UID. Once that happens there is no remaining
  // owner of the UID that can create another descendant.
  for (;;) {
    let entries: string[];
    try {
      entries = await readdir('/proc');
    } catch (error) {
      throw new Error('CONVERTER_PROCESS_SWEEP_UNAVAILABLE', { cause: error });
    }
    let killedThisPass = 0;
    for (const entry of entries) {
      if (!/^\d+$/u.test(entry)) continue;
      const pid = Number(entry);
      if (pid === process.pid) continue;
      let status: string;
      try {
        status = await readFile(`/proc/${entry}/status`, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new Error('CONVERTER_PROCESS_SWEEP_UNAVAILABLE', { cause: error });
      }
      // Distinguish an executable process from a zombie waiting for the
      // container's init process to reap it. Zombies cannot execute or fork; a
      // status-only loop would otherwise keep signalling the same dead PID.
      const live = !/^State:\s*Z\b/mu.test(status);
      if (!live) continue;
      // Real UID is the first field; a converter cannot alter it.
      const real = /^Uid:\s*(\d+)/mu.exec(status)?.[1];
      if (real === undefined || Number(real) !== slot.uid) continue;
      try {
        process.kill(pid, 'SIGKILL');
        killedThisPass += 1;
        killed += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
          throw new Error('CONVERTER_PROCESS_SWEEP_FAILED', { cause: error });
      }
    }
    if (killedThisPass === 0) return killed;
  }
}
