import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function muPdfArguments(inputPath: string): readonly string[] {
  // MuPDF 1.25 draw: PNG raster output, numbered scratch output, fixed 144 DPI,
  // and fixed 8-bit antialiasing. `draw` renders without executing PDF actions.
  return ['draw', '-F', 'png', '-o', 'page-%04d.png', '-r', '144', '-A', '8', inputPath];
}
export function imageMagickArguments(inputPath: string): readonly string[] {
  // ImageMagick 7: decode only the first frame, orient pixels, remove all
  // profiles/comments, then encode a fresh PNG in the private scratch directory.
  return [`${inputPath}[0]`, '-auto-orient', '-strip', 'page-0001.png'];
}
export function textMagickArguments(): readonly string[] {
  // `caption:@-` reads validated text only from stdin. The policy grants that
  // exact stream while continuing to deny every filesystem @path.
  return [
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
  ];
}
function run(
  tool: string,
  arguments_: readonly string[],
  directory: string,
  input?: Uint8Array,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(tool, arguments_, {
      cwd: directory,
      env: process.env,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'],
    });
    child.once('error', () => {
      reject(new Error('PROCESSOR_TOOL_FAILED'));
    });
    if (input !== undefined) {
      if (child.stdin === null) {
        reject(new Error('PROCESSOR_TOOL_FAILED'));
        return;
      }
      child.stdin.end(input);
    }
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('PROCESSOR_TOOL_FAILED'));
    });
  });
}
async function main(): Promise<void> {
  const tool = process.argv[2];
  const mode = process.argv[3];
  if (tool === undefined || !['pdf', 'image', 'text'].includes(mode ?? ''))
    throw new Error('PROCESSOR_ADAPTER_ARGUMENTS_INVALID');
  const chunks: Uint8Array[] = [];
  process.stdin.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });
  await new Promise<void>((resolve, reject) => {
    process.stdin.once('end', resolve);
    process.stdin.once('error', reject);
  });
  const input = Buffer.concat(chunks);
  const directory = await mkdtemp(join(tmpdir(), 'duefold-adapter-'));
  try {
    const inputPath = join(directory, mode === 'pdf' ? 'source.pdf' : 'source');
    await writeFile(inputPath, input);
    const arguments_ =
      mode === 'pdf'
        ? muPdfArguments(inputPath)
        : mode === 'image'
          ? imageMagickArguments(inputPath)
          : textMagickArguments();
    await run(tool, arguments_, directory, mode === 'text' ? input : undefined);
    const pageNames = (await readdir(directory))
      .filter((name) => /^page-\d{4}\.png$/u.test(name))
      .sort();
    if (pageNames.length < 1 || pageNames.length > 10_000)
      throw new Error('PROCESSOR_RESPONSE_INVALID');
    const pages: {
      mediaType: 'image/png';
      imageBase64: string;
      width: number;
      height: number;
      accessibleLabel: string;
      textLayer: null;
    }[] = [];
    for (const [index, name] of pageNames.entries()) {
      const image = await readFile(join(directory, name));
      if (image.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
        throw new Error('PROCESSOR_RESPONSE_INVALID');
      pages.push({
        mediaType: 'image/png',
        imageBase64: image.toString('base64'),
        width: image.readUInt32BE(16),
        height: image.readUInt32BE(20),
        accessibleLabel: `Page ${String(index + 1)}`,
        textLayer: null,
      });
    }
    process.stdout.write(JSON.stringify({ pages, hiddenSheets: [] }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href)
  await main();
