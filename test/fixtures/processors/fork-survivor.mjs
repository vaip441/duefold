import { fork } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const outside = process.argv[2];
const marker = process.argv[3];
if (process.argv.includes('--survivor')) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (outside !== undefined) await writeFile(outside, 'escaped');
  await new Promise(() => undefined);
}
if (outside !== undefined && marker !== undefined) {
  fork(import.meta.filename, [outside, marker, '--survivor'], {
    detached: true,
    stdio: 'ignore',
  }).unref();
  process.stdout.write(marker);
  await new Promise(() => undefined);
}
