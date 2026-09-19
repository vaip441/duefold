const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
if (process.argv[2] !== 'watermark-page' || process.argv[3] !== '--stdin-envelope')
  process.exit(2);
const forbidden = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'DATABASE_URL',
  'DUEFOLD_TEST_DATABASE_URL',
  'DUEFOLD_STORAGE_WEB_SECRET_ACCESS_KEY',
];
if (forbidden.some((name) => process.env[name] !== undefined)) process.exit(3);
const image = Buffer.from(envelope.imageBase64, 'base64');
const mark = Buffer.from(
  `\n${envelope.watermark.email}|${envelope.watermark.accessDateUtc}|${envelope.watermark.roomName}`,
  'utf8',
);
process.stdout.write(Buffer.concat([image, mark]));
