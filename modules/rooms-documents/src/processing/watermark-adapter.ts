import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface WatermarkData {
  readonly email: string;
  readonly accessDateUtc: string;
  readonly roomName: string;
}

export interface WatermarkEnvelope {
  readonly watermark: WatermarkData;
  readonly imageBase64: string;
}

const WATERMARK_FONT = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc';

export function detectPng(buffer: Buffer): { readonly width: number; readonly height: number } {
  if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
    throw new Error('WATERMARK_INPUT_UNSUPPORTED');
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width < 1 || height < 1) throw new Error('WATERMARK_INPUT_UNSUPPORTED');
  return { width, height };
}

function run(tool: string, arguments_: readonly string[], directory: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(tool, arguments_, {
      cwd: directory,
      env: process.env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const stderrChunks: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.once('error', (error) => {
      reject(new Error('WATERMARK_TOOL_FAILED', { cause: error }));
    });
    child.once('close', (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `WATERMARK_TOOL_FAILED: ${Buffer.concat(stderrChunks).toString('utf8').trim()}`,
          ),
        );
    });
  });
}

function validEnvelope(value: unknown): value is WatermarkEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const watermark = record['watermark'];
  if (typeof watermark !== 'object' || watermark === null || Array.isArray(watermark))
    return false;
  const marks = watermark as Record<string, unknown>;
  return (
    typeof record['imageBase64'] === 'string' &&
    record['imageBase64'] !== '' &&
    typeof marks['email'] === 'string' &&
    marks['email'].trim() !== '' &&
    typeof marks['accessDateUtc'] === 'string' &&
    marks['accessDateUtc'].trim() !== '' &&
    typeof marks['roomName'] === 'string' &&
    marks['roomName'].trim() !== ''
  );
}

export async function processWatermarkEnvelope(
  tool: string,
  rawEnvelope: string,
): Promise<Buffer> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawEnvelope);
  } catch {
    throw new Error('WATERMARK_ENVELOPE_INVALID');
  }
  if (!validEnvelope(parsed)) throw new Error('WATERMARK_ENVELOPE_INVALID');
  if (!existsSync(WATERMARK_FONT)) throw new Error('WATERMARK_FONT_MISSING');

  const source = Buffer.from(parsed.imageBase64, 'base64');
  detectPng(source);
  const directory = await mkdtemp(join(tmpdir(), 'duefold-watermark-'));
  const sourcePath = join(directory, 'source.png');
  const tilePath = join(directory, 'tile.png');
  const outputPath = join(directory, 'watermarked.png');
  const text =
    `${parsed.watermark.email}\n${parsed.watermark.accessDateUtc} • ${parsed.watermark.roomName}`.replace(
      /%/gu,
      '%%',
    );

  try {
    await writeFile(sourcePath, source);
    // The `caption:` prefix means a leading @ or - is text rather than an
    // ImageMagick option. Percent escapes are doubled before this argument.
    await run(
      tool,
      [
        '-background',
        'none',
        '-fill',
        'rgba(80,80,80,0.20)',
        '-font',
        WATERMARK_FONT,
        '-pointsize',
        '18',
        '-size',
        '520x260',
        `caption:${text}`,
        '-gravity',
        'center',
        '-rotate',
        '-30',
        tilePath,
      ],
      directory,
    );
    await run(
      tool,
      [
        sourcePath,
        '-strip',
        '(',
        '+clone',
        '-tile',
        tilePath,
        '-draw',
        'color 0,0 reset',
        ')',
        '-compose',
        'over',
        '-composite',
        outputPath,
      ],
      directory,
    );
    const output = await readFile(outputPath);
    detectPng(output);
    return output;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const tool = process.argv[2];
  if (
    tool === undefined ||
    tool === '' ||
    process.argv[3] !== 'watermark-page' ||
    process.argv[4] !== '--stdin-envelope'
  )
    throw new Error('WATERMARK_ADAPTER_ARGUMENTS_INVALID');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  process.stdout.write(
    await processWatermarkEnvelope(tool, Buffer.concat(chunks).toString('utf8')),
  );
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href)
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'UNKNOWN_ERROR'}\n`);
    process.exit(1);
  });
