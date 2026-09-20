// Temporary CI diagnostic. Runs the workbook adapter child the way the sandbox
// does, as root, with stderr visible — invokeSandboxed drops the child's stderr,
// so the root-only PROCESSOR_REWRITE_FAILED -> SANDBOX_CHILD_FAILED difference is
// invisible from the test alone. Delete once the cause is understood.
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const adapter = new URL(
  '../../modules/rooms-documents/src/processing/workbook-adapter.ts',
  import.meta.url,
).pathname;

console.log('uid', process.getuid(), 'euid', process.geteuid());

const directory = await mkdtemp(join(tmpdir(), 'duefold-diag-'));
const argv = [
  '--unshare-user',
  '--unshare-pid',
  '--unshare-net',
  '--die-with-parent',
  '--new-session',
  '--bind',
  directory,
  directory,
  '--chdir',
  directory,
  '--',
  '/usr/bin/setpriv',
  '--no-new-privs',
  '--',
  process.execPath,
  adapter,
  '/bin/false',
  '/bin/false',
  'xlsx',
];
console.log('bwrap argv:', argv.join(' '));
const child = spawn('/usr/bin/bwrap', argv, {
  env: {
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    HOME: '/nonexistent',
    PATH: '/usr/bin:/bin',
    TMPDIR: directory,
  },
  stdio: ['pipe', 'pipe', 'inherit'],
  cwd: directory,
});
child.stdin.end(Buffer.from('not a workbook'));
let out = '';
child.stdout.on('data', (chunk) => {
  out += chunk;
});
child.on('close', (code, signal) => {
  console.log('exit code:', code, 'signal:', signal);
  console.log('stdout:', JSON.stringify(out));
});
