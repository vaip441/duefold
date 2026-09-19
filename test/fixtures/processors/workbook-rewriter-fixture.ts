import { rewriteWorkbook } from '../../../modules/rooms-documents/src/processing/workbook-rewriter.ts';

const chunks: Uint8Array[] = [];
process.stdin.on('data', (chunk: Buffer) => {
  chunks.push(chunk);
});
await new Promise<void>((resolve, reject) => {
  process.stdin.once('end', resolve);
  process.stdin.once('error', reject);
});
const mode = process.argv[2];
if (mode !== 'xlsx' && mode !== 'ods') throw new Error('FIXTURE_MODE_INVALID');
const mediaType =
  mode === 'xlsx'
    ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    : 'application/vnd.oasis.opendocument.spreadsheet';
const rewritten = rewriteWorkbook(Buffer.concat(chunks), mediaType);
process.stdout.write(
  JSON.stringify({
    pages: [
      {
        mediaType: 'image/png',
        imageBase64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==',
        width: 1,
        height: 1,
        accessibleLabel: 'Workbook page 1',
        textLayer: null,
      },
    ],
    hiddenSheets: rewritten.hiddenSheets,
  }),
);
