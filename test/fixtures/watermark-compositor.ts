/**
 * Watermark compositor stand-in for tests.
 *
 * Speaks the real contract: `watermark-page --stdin-envelope`, reading a JSON
 * envelope from stdin and writing image bytes to stdout. It does not draw the
 * watermark -- there is no image library in the harness -- but it PROVES the
 * envelope carried the three required marks (viewer email, UTC
 * access date, room name) by failing loudly when any is missing, so a regression
 * that stops attributing pages fails here rather than shipping.
 *
 * The bytes it returns are the source image unchanged, which is what lets the
 * browser render a decodable page.
 */

import { Buffer } from 'node:buffer';

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const mode = process.argv[2];
const flag = process.argv[3];
if (mode !== 'watermark-page') fail(`unexpected mode: ${String(mode)}`);
if (flag !== '--stdin-envelope') fail(`unexpected flag: ${String(flag)}`);

const chunks: Buffer[] = [];
process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
process.stdin.on('end', () => {
  let envelope: unknown;
  try {
    envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail('envelope is not valid JSON');
  }
  if (typeof envelope !== 'object' || envelope === null) fail('envelope is not an object');
  const record = envelope as Record<string, unknown>;
  const watermark = record['watermark'];
  if (typeof watermark !== 'object' || watermark === null) fail('watermark absent');
  const marks = watermark as Record<string, unknown>;
  // Every mark 14.2 requires must be present and non-empty.
  for (const key of ['email', 'accessDateUtc', 'roomName']) {
    const value = marks[key];
    if (typeof value !== 'string' || value.trim() === '') fail(`watermark.${key} absent`);
  }
  const imageBase64 = record['imageBase64'];
  if (typeof imageBase64 !== 'string' || imageBase64 === '') fail('imageBase64 absent');
  process.stdout.write(Buffer.from(imageBase64, 'base64'));
});
