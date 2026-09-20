const { readFile, writeFile } = await import('node:fs/promises');
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks).toString('utf8');
if (process.argv.includes('--fixture-timeout')) await new Promise(() => undefined);
if (process.argv.includes('--fixture-crash')) {
  await writeFile('crash-plaintext', 'temporary');
  process.exit(9);
}
if (process.argv.includes('--fixture-overflow')) {
  process.stdout.write('x'.repeat(1024 * 1024));
  process.exit(0);
}
if (process.argv.includes('--fixture-inspect')) {
  let security;
  try {
    security = Object.fromEntries(
      (await readFile('/proc/self/status', 'utf8'))
        .split('\n')
        .filter((line) => /^(?:CapEff|CapBnd|NoNewPrivs):/u.test(line))
        .map((line) => {
          const separator = line.indexOf(':');
          return [line.slice(0, separator), line.slice(separator + 1).trim()];
        }),
    );
  } catch {
    // A qualified namespaced sandbox intentionally need not mount host /proc.
    security = undefined;
  }
  process.stdout.write(
    JSON.stringify({
      argv: process.argv.slice(2),
      env: process.env,
      cwd: process.cwd(),
      uid: process.getuid?.(),
      gid: process.getgid?.(),
      security,
    }),
  );
  process.exit(0);
}
if (process.argv.includes('--fixture-read-paths')) {
  const results = [];
  for (const path of process.argv.slice(process.argv.indexOf('--fixture-read-paths') + 1)) {
    try {
      await readFile(path, 'utf8');
      results.push('readable');
    } catch {
      results.push('denied');
    }
  }
  process.stdout.write(JSON.stringify(results));
  process.exit(0);
}
const unsafeValueArgument = process.argv.find((argument) =>
  argument.startsWith('--fixture-text='),
);
const textLayer = process.argv.includes('--fixture-unsafe-text')
  ? [{ text: '<script>x</script>', x: 0, y: 0, width: 1, height: 1 }]
  : unsafeValueArgument !== undefined
    ? [
        {
          text: unsafeValueArgument.slice('--fixture-text='.length),
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        },
      ]
    : input.includes('NO_TEXT')
      ? null
      : [{ text: input.slice(0, 100) || 'fixture', x: 0, y: 0, width: 1, height: 1 }];
process.stdout.write(
  JSON.stringify({
    pages: [
      {
        mediaType: 'image/png',
        imageBase64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==',
        width: 1,
        height: 1,
        accessibleLabel: 'Page 1',
        textLayer,
      },
    ],
    hiddenSheets: [],
  }),
);
