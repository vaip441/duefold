import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const executeFile = promisify(execFile);

const SANDBOX_PROGRAM: unique symbol = Symbol('duefold.sandbox-program');
export interface SandboxProgram {
  readonly executable: string;
  readonly fixedArguments: readonly string[];
  readonly requiredFiles: readonly string[];
  readonly [SANDBOX_PROGRAM]: true;
}
export function sandboxProgram(
  executable: string,
  fixedArguments: readonly string[] = [],
  requiredFiles: readonly string[] = [],
): SandboxProgram {
  if (
    executable === '' ||
    executable.includes('\0') ||
    fixedArguments.some((value) => value.includes('\0')) ||
    requiredFiles.some((value) => !value.startsWith('/') || value.includes('\0'))
  )
    throw new Error('SANDBOX_PROGRAM_INVALID');
  return {
    executable,
    fixedArguments: [...fixedArguments],
    requiredFiles: [...requiredFiles],
    [SANDBOX_PROGRAM]: true,
  };
}
export interface SandboxLimits {
  readonly timeoutMilliseconds: number;
  readonly maximumOutputBytes: number;
  readonly maximumInputBytes: number;
  readonly maximumTemporaryBytes: number;
}
export interface SandboxInvocation {
  readonly program: SandboxProgram;
  readonly arguments: readonly string[];
  readonly input: Uint8Array;
  readonly limits: SandboxLimits;
  readonly signal?: AbortSignal;
}
const ALLOWED_CHILD_ENVIRONMENT = Object.freeze({
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  TZ: 'UTC',
  HOME: '/nonexistent',
  PATH: '/usr/bin:/bin',
  NO_PROXY: '*',
  http_proxy: 'http://127.0.0.1:1',
  https_proxy: 'http://127.0.0.1:1',
});

function scratchRoot(): string {
  const configured = process.env['TMPDIR'];
  return configured === undefined || configured === '' ? tmpdir() : configured;
}

async function directoryBytes(path: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let total = 0;
  for (const entry of entries) {
    const target = join(path, entry.name);
    try {
      if (entry.isDirectory()) total += await directoryBytes(target);
      else if (entry.isFile()) total += (await stat(target)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return total;
}

async function existingRealPath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}
function parentDirectories(path: string): readonly string[] {
  const values: string[] = [];
  let current = dirname(path);
  while (current !== '/') {
    values.push(current);
    current = dirname(current);
  }
  return values.reverse();
}
async function sharedLibraries(executable: string): Promise<readonly string[]> {
  let output: string;
  try {
    ({ stdout: output } = await executeFile('/usr/bin/ldd', [executable], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      env: process.env,
    }));
  } catch {
    return [];
  }
  const paths = output.match(/\/[A-Za-z0-9_+.,/@-]+/gu) ?? [];
  const targets = await Promise.all(paths.map(existingRealPath));
  return [
    ...new Set([...paths, ...targets.filter((path): path is string => path !== undefined)]),
  ];
}
const IMAGE_MODULES = new Set(['caption.so', 'jpeg.so', 'png.so', 'webp.so']);
async function discoverImageMagickDirectories(root: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const discovered: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const target = join(root, entry.name);
    if (entry.name.startsWith('ImageMagick-')) {
      discovered.push(target);
      let children;
      try {
        children = await readdir(target, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const child of children)
        if (child.isDirectory() && /^(?:config|modules)-Q/u.test(child.name))
          discovered.push(join(target, child.name));
      continue;
    }
    if (root === '/usr/lib' && entry.name.endsWith('-linux-gnu'))
      discovered.push(...(await discoverImageMagickDirectories(target)));
  }
  return discovered;
}
async function imageModuleFiles(directory: string): Promise<readonly string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await imageModuleFiles(target)));
    else if (entry.isFile() && IMAGE_MODULES.has(entry.name)) files.push(target);
  }
  return files;
}
async function runtimeFiles(
  invocation: SandboxInvocation,
  directory: string,
): Promise<{
  readonly executable: string;
  readonly fixedArguments: readonly string[];
  readonly files: readonly string[];
  readonly directories: readonly string[];
}> {
  const executable = await existingRealPath(invocation.program.executable);
  const setpriv = await existingRealPath('/usr/bin/setpriv');
  if (executable === undefined || setpriv === undefined)
    throw new Error('SANDBOX_PROGRAM_MISSING');
  const requiredFiles = (
    await Promise.all(invocation.program.requiredFiles.map(existingRealPath))
  ).filter((path): path is string => path !== undefined);
  if (requiredFiles.length !== invocation.program.requiredFiles.length)
    throw new Error('SANDBOX_PROGRAM_MISSING');
  const requiredSet = new Set(requiredFiles);
  const fixedArguments = await Promise.all(
    invocation.program.fixedArguments.map(async (argument, index) => {
      if (!argument.startsWith('/')) return argument;
      const source = await existingRealPath(argument);
      if (source === undefined) return argument;
      if (((await stat(source)).mode & 0o111) !== 0 || requiredSet.has(source)) return source;
      const extension = source.includes('.') ? source.slice(source.lastIndexOf('.')) : '';
      const target = join(directory, `runtime-${String(index)}${extension}`);
      await copyFile(source, target);
      return target;
    }),
  );
  const toolFiles = (
    await Promise.all(
      fixedArguments
        .filter((value) => value.startsWith('/') && !value.startsWith(directory))
        .map(existingRealPath),
    )
  ).filter((path): path is string => path !== undefined);
  const executableLibraries = (
    await Promise.all([executable, setpriv, ...toolFiles].map(sharedLibraries))
  ).flat();
  const staticCandidates = [
    '/etc/fonts',
    '/usr/share/fontconfig',
    '/var/cache/fontconfig',
    '/usr/lib/locale/C.utf8',
    '/usr/share/fonts/truetype/dejavu',
    '/usr/share/fonts/dejavu',
    '/usr/share/fonts/opentype/noto',
    '/usr/share/fonts/truetype/noto',
  ];
  // LibreOffice dlopens its import filters, and NSS its soft token, so their
  // system dependencies are invisible to ldd on soffice.bin. Office conversion
  // therefore gets the whole read-only system library directory.
  const systemLibraries = executableLibraries.find((path) => /\/libc\.so\.\d+$/u.test(path));
  const officeCandidates = toolFiles.some((path) => path.includes('/libreoffice/'))
    ? [
        ...(systemLibraries === undefined ? [] : [dirname(systemLibraries)]),
        '/etc/libreoffice',
        '/etc/ure',
        '/etc/hosts',
        '/etc/nsswitch.conf',
        '/etc/passwd',
        '/etc/group',
        '/etc/localtime',
        '/usr/lib/libreoffice',
        '/usr/lib/ure',
        '/usr/share/libreoffice',
        '/usr/share/ure',
        '/usr/share/mime',
        '/usr/share/liblangtag',
        '/usr/share/hyphen',
        '/var/lib/libreoffice',
        '/var/spool/libreoffice',
      ]
    : [];
  const discoveredImageMagick = (
    await Promise.all(
      ['/etc', '/usr/share', '/usr/lib'].map((root) => discoverImageMagickDirectories(root)),
    )
  ).flat();
  const directories = (
    await Promise.all(
      [...staticCandidates, ...officeCandidates, ...discoveredImageMagick].map(
        existingRealPath,
      ),
    )
  ).filter((path): path is string => path !== undefined);
  const moduleFiles = (
    await Promise.all(
      directories
        .filter((path) => path.includes('/modules-Q16'))
        .map((path) => imageModuleFiles(path)),
    )
  ).flat();
  const moduleLibraries = (await Promise.all(moduleFiles.map(sharedLibraries))).flat();
  return {
    executable,
    fixedArguments,
    files: [
      ...new Set([
        executable,
        setpriv,
        ...requiredFiles,
        ...toolFiles,
        ...executableLibraries,
        ...moduleLibraries,
      ]),
    ],
    directories,
  };
}
function mountArguments(
  files: readonly string[],
  readOnlyDirectories: readonly string[],
): readonly string[] {
  const directories = new Set<string>();
  for (const file of files)
    for (const directory of parentDirectories(file)) directories.add(directory);
  for (const directory of readOnlyDirectories)
    for (const parent of parentDirectories(directory)) directories.add(parent);
  return [
    ...[...directories].flatMap((directory) => ['--dir', directory]),
    ...files.flatMap((file) => ['--ro-bind', file, file]),
    ...readOnlyDirectories.flatMap((directory) => ['--ro-bind', directory, directory]),
  ];
}

/** The only child-process boundary for untrusted content. Bubblewrap creates a
 * private PID/network/user namespace and an empty runtime root containing only
 * explicitly selected executables, their shared libraries, processor adapter
 * files, and one writable scratch bind. The detached process group is killed
 * as a whole and the namespace init is reaped before scratch removal. */
export async function invokeSandboxed(invocation: SandboxInvocation): Promise<Uint8Array> {
  const { limits } = invocation;
  if (
    !Number.isSafeInteger(limits.timeoutMilliseconds) ||
    limits.timeoutMilliseconds < 1 ||
    !Number.isSafeInteger(limits.maximumOutputBytes) ||
    limits.maximumOutputBytes < 1 ||
    !Number.isSafeInteger(limits.maximumInputBytes) ||
    limits.maximumInputBytes < 1 ||
    !Number.isSafeInteger(limits.maximumTemporaryBytes) ||
    limits.maximumTemporaryBytes < 1 ||
    invocation.input.length > limits.maximumInputBytes ||
    invocation.arguments.some((argument) => argument.includes('\0'))
  )
    throw new Error('SANDBOX_LIMIT_INVALID');
  const directory = await mkdtemp(
    join(
      scratchRoot(),
      invocation.program.requiredFiles.length === 0 ? 'duefold-job-' : 'duefold-parser-job-',
    ),
  );
  try {
    const runtime = await runtimeFiles(invocation, directory);
    return await new Promise((resolve, reject) => {
      const child = spawn(
        '/usr/bin/bwrap',
        [
          '--unshare-user',
          '--unshare-pid',
          '--unshare-net',
          '--die-with-parent',
          '--new-session',
          '--tmpfs',
          '/',
          ...mountArguments(runtime.files, runtime.directories),
          '--dir',
          '/nonexistent',
          '--bind',
          directory,
          directory,
          '--dev',
          '/dev',
          '--chdir',
          directory,
          '--',
          '/usr/bin/setpriv',
          '--no-new-privs',
          '--',
          runtime.executable,
          ...runtime.fixedArguments,
          ...invocation.arguments,
        ],
        {
          env: { ...ALLOWED_CHILD_ENVIRONMENT, TMPDIR: directory },
          stdio: ['pipe', 'pipe', 'ignore'],
          windowsHide: true,
          detached: true,
        },
      );
      const stdout = child.stdout;
      const stdin = child.stdin;
      const chunks: Buffer[] = [];
      let length = 0;
      let requestedError: Error | undefined;
      let closed = false;
      const requestKill = (code: string): void => {
        if (requestedError !== undefined || closed) return;
        requestedError = new Error(code);
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        } else child.kill('SIGKILL');
      };
      const abort = (): void => {
        requestKill('SANDBOX_ABORTED');
      };
      const timer = setTimeout(() => {
        requestKill('SANDBOX_TIMEOUT');
      }, limits.timeoutMilliseconds);
      const temporaryMonitor = setInterval(() => {
        void directoryBytes(directory)
          .then((size) => {
            if (size > limits.maximumTemporaryBytes) requestKill('SANDBOX_TEMPORARY_LIMIT');
          })
          .catch(() => {
            if (closed || child.exitCode !== null) return;
            requestKill('SANDBOX_TEMPORARY_INSPECTION_FAILED');
          });
      }, 25);
      invocation.signal?.addEventListener('abort', abort, { once: true });
      const finish = (error?: Error): void => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        clearInterval(temporaryMonitor);
        invocation.signal?.removeEventListener('abort', abort);
        if (error === undefined) resolve(Buffer.concat(chunks));
        else reject(error);
      };
      child.once('error', () => {
        finish(new Error('SANDBOX_SPAWN_FAILED'));
      });
      stdout.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > limits.maximumOutputBytes) requestKill('SANDBOX_OUTPUT_LIMIT');
        else chunks.push(chunk);
      });
      child.once('close', (code, signal) => {
        if (requestedError !== undefined) finish(requestedError);
        else if (code !== 0)
          finish(new Error(signal === null ? 'SANDBOX_CHILD_FAILED' : 'SANDBOX_CHILD_KILLED'));
        else finish();
      });
      stdin.once('error', () => undefined);
      stdin.end(invocation.input);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export const sandboxEnvironmentKeys = (): readonly string[] =>
  Object.keys(ALLOWED_CHILD_ENVIRONMENT);
