// Temporary CI diagnostic, paired with a one-line stderr change in sandbox.ts on
// this branch only. Runs the exact failing invocation so the child's own error is
// visible as root. Delete with the branch.
import { createProcessorPrograms, processSource } from '../../modules/rooms-documents/src/processing/formats.ts';

console.log('uid', process.getuid(), 'euid', process.geteuid());

const programs = createProcessorPrograms({
  pdf: '/bin/false',
  office: '/bin/false',
  image: '/bin/false',
  text: '/bin/false',
});

try {
  await processSource({
    mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    bytes: Buffer.from('not a workbook'),
    programs,
    limits: {
      timeoutMilliseconds: 5_000,
      maximumOutputBytes: 1_024,
      maximumInputBytes: 1_024,
      maximumTemporaryBytes: 1024 * 1024,
    },
  });
  console.log('RESULT: resolved unexpectedly');
} catch (error) {
  console.log('RESULT: rejected with', error instanceof Error ? error.message : String(error));
}
