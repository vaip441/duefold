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

function reorderLast(firstOrderKey: string) {
  const queries: string[] = [];
  const sibling = (entryId: string, position: number) => ({
    entry_id: entryId,
    resource_kind: 'folder',
    resource_id: entryId,
    parent_folder_id: null,
    display_name: `Folder ${String(position)}`,
    description: '',
    revision: 1,
    document_revision: null,
    staged_removed: false,
    depth: 0,
    sibling_position: position,
    can_move_up: position > 1,
    can_move_down: position < 2,
    change_kinds: [],
    has_publishable_version: false,
    is_published: false,
  });
  const runtime = {
    pool: {
      query: (sql: string) => {
        queries.push(sql);
        if (sql.includes('read_member_working_structure'))
          return Promise.resolve({
            rows: [sibling('a'.repeat(32), 1), sibling('b'.repeat(32), 2)],
          });
        if (sql.includes('read_structure_entry_revision'))
          return Promise.resolve({ rows: [{ order_key: firstOrderKey }] });
        return Promise.resolve({ rows: [{ entry_revision: 2, working_revision: 2 }] });
      },
    },
  };
  const result = createHandler(runtime as never, { id: 'm'.repeat(32) } as never)(
    {
      body: {
        action: 'reorder',
        roomId: ROOM_ID,
        entryId: 'b'.repeat(32),
        targetPosition: 1,
        expectedEntryRevision: 1,
        expectedWorkingRevision: 1,
      },
    } as never,
    { code: () => undefined } as never,
  );
  return { result, queries };
}

describe('a reorder', () => {
  it('reads the room tree once', async () => {
    const { result, queries } = reorderLast('1024.000000000000000');
    await result;
    expect(queries.filter((sql) => sql.includes('read_member_working_structure'))).toHaveLength(
      1,
    );
  });

  it('refuses a neighbour order key that does not parse instead of ignoring the neighbour', async () => {
    await expect(reorderLast('corrupt').result).rejects.toThrow('STRUCTURE_ORDER_KEY_INVALID');
  });
});
