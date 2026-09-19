import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { muPdfArguments } from './tool-adapter.ts';
import { rewriteWorkbook } from './workbook-rewriter.ts';

export function libreOfficeArguments(
  profileDirectory: string,
  inputPath: string,
  outputDirectory: string,
): readonly string[] {
  // LibreOffice 25.2: headless suppresses UI; a fresh file-URL UserInstallation
  // isolates the profile; convert-to selects the real Calc PDF export filter; outdir keeps
  // all generated plaintext in per-job sandbox scratch. Security semantics come
  // from structural rewriting, not invented converter switches.
  return [
    '--headless',
    `-env:UserInstallation=file://${profileDirectory}`,
    '--convert-to',
    'pdf:calc_pdf_Export',
    '--outdir',
    outputDirectory,
    inputPath,
  ];
}
/** soffice.bin runs directly because its soffice and oosplash wrappers need a
 * shell and procfs, neither of which the sandbox provides. */
function runOffice(
  converter: string,
  arguments_: readonly string[],
  directory: string,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(converter, arguments_, {
      cwd: directory,
      // Without procfs the loader cannot expand soffice.bin's $ORIGIN runpath.
      env: { ...process.env, LD_LIBRARY_PATH: dirname(converter) },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.once('error', () => {
      reject(new Error('PROCESSOR_TOOL_FAILED'));
    });
    child.once('close', resolve);
  });
}
async function inputBytes(): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  process.stdin.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });
  await new Promise<void>((resolve, reject) => {
    process.stdin.once('end', resolve);
    process.stdin.once('error', reject);
  });
  return Buffer.concat(chunks);
}
async function main(): Promise<void> {
  let stage: 'arguments' | 'rewrite' | 'office' | 'render' | 'response' = 'arguments';
  let directory: string | undefined;
  try {
    const converter = process.argv[2];
    const renderer = process.argv[3];
    const mode = process.argv[4];
    if (
      converter === undefined ||
      renderer === undefined ||
      (mode !== 'xlsx' && mode !== 'ods')
    )
      throw new Error('PROCESSOR_ADAPTER_ARGUMENTS_INVALID');
    const mediaType =
      mode === 'xlsx'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'application/vnd.oasis.opendocument.spreadsheet';
    stage = 'rewrite';
    const rewritten = rewriteWorkbook(await inputBytes(), mediaType);
    directory = await mkdtemp(join(tmpdir(), 'duefold-workbook-'));
    const workDirectory = directory;
    const inputPath = join(workDirectory, `source.${mode}`);
    const profileDirectory = join(workDirectory, 'profile');
    await writeFile(inputPath, rewritten.bytes);
    stage = 'office';
    const officeArguments = libreOfficeArguments(profileDirectory, inputPath, workDirectory);
    // A fresh profile makes soffice.bin exit 81 (EXITHELPER_NORMAL_RESTART) once
    // it is initialised; the wrappers relaunch it, and so does this adapter.
    let exitCode = await runOffice(converter, officeArguments, workDirectory);
    if (exitCode === 81) exitCode = await runOffice(converter, officeArguments, workDirectory);
    if (exitCode !== 0) throw new Error('PROCESSOR_TOOL_FAILED');
    // soffice.bin also exits 0 when the export fails, so the PDF is the result.
    const pdfPath = join(workDirectory, 'source.pdf');
    await access(pdfPath);
    stage = 'render';
    await new Promise<void>((resolve, reject) => {
      const processor = spawn(renderer, muPdfArguments(pdfPath), {
        cwd: workDirectory,
        env: process.env,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      processor.once('error', () => {
        reject(new Error('PROCESSOR_TOOL_FAILED'));
      });
      processor.once('close', (code) => {
        if (code !== 0) reject(new Error('PROCESSOR_TOOL_FAILED'));
        else resolve();
      });
    });
    stage = 'response';
    const pageNames = (await readdir(workDirectory))
      .filter((name) => /^page-\d{4}\.png$/u.test(name))
      .sort();
    const directoryEntries = await readdir(workDirectory, { withFileTypes: true });
    const regularBytes = await Promise.all(
      directoryEntries
        .filter((entry) => entry.isFile())
        .map(async (entry) => (await readFile(join(workDirectory, entry.name))).length),
    );
    const outputBytes = regularBytes.reduce((sum, length) => sum + length, 0);
    if (outputBytes > 1024 * 1024 * 1024) throw new Error('PROCESSOR_RESPONSE_INVALID');
    if (pageNames.length < 1 || pageNames.length > 10_000)
      throw new Error('PROCESSOR_RESPONSE_INVALID');
    const pages = [];
    for (const [index, name] of pageNames.entries()) {
      const image = await readFile(join(workDirectory, name));
      if (image.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
        throw new Error('PROCESSOR_RESPONSE_INVALID');
      pages.push({
        mediaType: 'image/png' as const,
        imageBase64: image.toString('base64'),
        width: image.readUInt32BE(16),
        height: image.readUInt32BE(20),
        accessibleLabel: `Page ${String(index + 1)}`,
        textLayer: null,
      });
    }
    process.stdout.write(JSON.stringify({ pages, hiddenSheets: rewritten.hiddenSheets }));
  } catch {
    process.stdout.write(JSON.stringify({ processorError: stage }));
  } finally {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
}
if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href)
  await main();
