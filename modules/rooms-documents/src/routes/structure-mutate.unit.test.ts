import { describe, expect, it } from 'vitest';
import { createHandler } from './structure-mutate.ts';

const ROOM_ID = 'r'.repeat(32);

function rename(revisionRows: readonly { readonly working_revision: number }[]) {
  const runtime = {
    pool: {
      query: (sql: string) =>
        Promise.resolve({
          rows: sql.includes('read_room_structure_revisions') ? revisionRows : [],
        }),
    },
  };
  return createHandler(runtime as never, { id: 'm'.repeat(32) } as never)(
    {
      body: {
        action: 'rename',
        roomId: ROOM_ID,
        entryId: 'e'.repeat(32),
        displayName: 'Board minutes',
        expectedEntryRevision: 1,
        expectedWorkingRevision: 1,
      },
    } as never,
    { code: () => undefined } as never,
  );
}

describe('an entry the working structure does not return', () => {
  it('is the uniform denial when the caller cannot work in the room', async () => {
    await expect(rename([])).rejects.toThrow('ROOM_WORKSPACE_FORBIDDEN');
  });

  it('is a stale view to reload when the room is the caller’s to work in', async () => {
    await expect(rename([{ working_revision: 3 }])).rejects.toThrow(
      'STRUCTURE_ENTRY_UNREACHABLE',
    );
  });
});
