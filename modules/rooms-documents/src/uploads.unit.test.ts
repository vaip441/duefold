import { describe, expect, it } from 'vitest';
import { createUploadIntent } from './uploads.ts';

function intentFor(displayTitle: string) {
  return createUploadIntent({
    pool: {
      connect: () => Promise.reject(new Error('database reached')),
    } as never,
    storage: { checksumSupport: false } as never,
    identity: { id: 'm'.repeat(32) } as never,
    input: {
      roomId: 'r'.repeat(32),
      displayTitle,
      originalFilename: 'notes.txt',
      declaredMediaType: 'text/plain',
      declaredSize: 1,
      parts: [{ partNumber: 1, size: 1 }],
    },
    now: new Date(),
  });
}

describe('upload display titles', () => {
  it.each(['Notes\u0085', 'Notes ', ' 　'])(
    'refuses %j before any transfer, as the structure name it becomes would be',
    async (displayTitle) => {
      await expect(intentFor(displayTitle)).rejects.toThrow('STRUCTURE_NAME_REJECTED');
    },
  );
});
