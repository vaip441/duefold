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
const TEXT_COLUMNS = 100;
const TEXT_ROWS_PER_PAGE = 60;
// Each page is one ImageMagick run of about a quarter second, so this bound keeps
// the largest text well inside the sandbox's 120 s processing limit.
export const MAX_TEXT_PAGES = 100;
// A row holds at most TEXT_COLUMNS four-byte characters and a CRLF, so a larger
// input cannot fit the page bound and is refused before it is decoded.
const MAX_TEXT_BYTES = MAX_TEXT_PAGES * TEXT_ROWS_PER_PAGE * (4 * TEXT_COLUMNS + 2);
/** A failure caused by the input. Every other error is the host's (spawn, signal,
 * scratch I/O) and exits non-zero so the parent keeps the job retryable. */
class InputRejected extends Error {}

/** Hard-wraps text into pages of at most TEXT_ROWS_PER_PAGE rows of TEXT_COLUMNS
 * characters, so every page fits the fixed canvas whatever its line lengths. */
export function textPages(bytes: Uint8Array): readonly string[] {
  if (bytes.length > MAX_TEXT_BYTES) throw new InputRejected('PROCESSOR_TEXT_PAGES_EXCEEDED');
  const lines = new TextDecoder('utf-8', { fatal: true })
    .decode(bytes)
    .replace(/(?:\r\n|[\n\r])$/u, '')
    .split(/\r\n|[\n\r]/u);
  const rows: string[] = [];
  for (const line of lines) {
    const characters = Array.from(line);
    for (let start = 0; start === 0 || start < characters.length; start += TEXT_COLUMNS) {
      if (rows.length === MAX_TEXT_PAGES * TEXT_ROWS_PER_PAGE)
        throw new InputRejected('PROCESSOR_TEXT_PAGES_EXCEEDED');
      rows.push(characters.slice(start, start + TEXT_COLUMNS).join(''));
    }
  }
  const pages: string[] = [];
  for (let start = 0; start < rows.length; start += TEXT_ROWS_PER_PAGE)
    pages.push(rows.slice(start, start + TEXT_ROWS_PER_PAGE).join('\n'));
  return pages;
}
export function textMagickArguments(pageName: string): readonly string[] {
  // `-annotate @-` reads one validated page only from stdin; the policy grants
  // that exact stream while denying every filesystem @path. `caption:` is not
  // used because it refuses text over 2000 bytes at 16 pt under the 16KP width
  // limit. TEXT_COLUMNS glyphs and TEXT_ROWS_PER_PAGE lines fit this canvas.
  return [
    '-size',
    '1200x1464',
    'xc:white',
    '-fill',
    'black',
    '-font',
    '/usr/share/fonts/truetype/noto/NotoSansMono-Regular.ttf',
    '-pointsize',
    '16',
    '-gravity',
    'northwest',
    '-annotate',
    '+12+12',
    '@-',
    '-strip',
    pageName,
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
    child.once('error', reject);
    if (input !== undefined) {
      if (child.stdin === null) {
        reject(new Error('TOOL_STDIN_UNAVAILABLE'));
        return;
      }
      // A tool that exits before reading breaks the pipe; its exit status decides.
      child.stdin.once('error', () => undefined);
      child.stdin.end(input);
    }
    child.once('close', (code) => {
      if (code === 0) resolve();
      // A null code is a signal kill, such as the OOM killer: the host, not the input.
      else if (code === null) reject(new Error('TOOL_KILLED_BY_SIGNAL'));
      else reject(new InputRejected('PROCESSOR_TOOL_FAILED'));
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
  let stage: 'render' | 'response' = 'render';
  try {
    if (mode === 'text') {
      for (const [index, page] of textPages(input).entries())
        await run(
          tool,
          textMagickArguments(`page-${String(index + 1).padStart(4, '0')}.png`),
          directory,
          Buffer.from(page),
        );
    } else {
      const inputPath = join(directory, mode === 'pdf' ? 'source.pdf' : 'source');
      await writeFile(inputPath, input);
      await run(
        tool,
        mode === 'pdf' ? muPdfArguments(inputPath) : imageMagickArguments(inputPath),
        directory,
      );
    }
    stage = 'response';
    const pageNames = (await readdir(directory))
      .filter((name) => /^page-\d{4}\.png$/u.test(name))
      .sort();
    if (pageNames.length < 1 || pageNames.length > 10_000)
      throw new InputRejected('PROCESSOR_RESPONSE_INVALID');
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
        throw new InputRejected('PROCESSOR_RESPONSE_INVALID');
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
  } catch (error) {
    if (!(error instanceof InputRejected)) throw error;
    process.stdout.write(JSON.stringify({ processorError: stage }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href)
  await main();
