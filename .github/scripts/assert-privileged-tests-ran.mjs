#!/usr/bin/env node
// Fails when the privileged degraded-isolation assertions did not actually run.
//
// The degraded launch mode drops the converter to a separate uid, which requires
// root, so those tests are guarded with `it.runIf(privileged)`. A guard that is
// never satisfied is indistinguishable from a deleted test, and these two
// assertions are the regression tests for the defects that made the first
// implementation of the mode unsafe: a converter reading the service process's
// /proc/<pid>/environ, and a setsid descendant outliving its own timeout.
//
// Usage: node .github/scripts/assert-privileged-tests-ran.mjs <vitest-json>
import { readFile } from 'node:fs/promises';

const REQUIRED = [
  'confines credentials and bounds resources when isolation is degraded',
  'denies a degraded converter the service process environment',
  'kills a degraded descendant that escapes its process group',
  'exposes the host filesystem in degraded mode, unlike the namespaced boundary',
];

const path = process.argv[2];
if (path === undefined) {
  process.stderr.write('usage: assert-privileged-tests-ran.mjs <vitest-json>\n');
  process.exit(2);
}

const report = JSON.parse(await readFile(path, 'utf8'));
const results = (report.testResults ?? []).flatMap((file) =>
  (file.assertionResults ?? []).map((test) => ({ title: test.title, status: test.status })),
);

let failed = false;
for (const title of REQUIRED) {
  const match = results.find((test) => test.title === title);
  if (match === undefined) {
    process.stderr.write(`missing privileged test: ${title}\n`);
    failed = true;
  } else if (match.status !== 'passed') {
    process.stderr.write(`privileged test did not run (${match.status}): ${title}\n`);
    failed = true;
  } else process.stdout.write(`ran: ${title}\n`);
}
process.exit(failed ? 1 : 0);
