import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { createHandler, schema } from './processing-state.ts';

const ajvRequire = createRequire(import.meta.url);
const Ajv = ajvRequire('ajv') as new (options: Readonly<Record<string, unknown>>) => {
  compile: (declared: unknown) => (value: unknown) => boolean;
};
const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });

const ROOM_ID = 'r'.repeat(32);
const VERSION_ID = 'v'.repeat(32);
/* Microseconds a Date cannot carry: the cursor must survive them. */
const CREATED_AT_TEXT = '2026-10-13T09:15:42.123456Z';

function row(continues: boolean) {
  return {
    document_id: 'd'.repeat(32),
    version_id: VERSION_ID,
    display_title: 'Board minutes',
    state: 'processing_failed',
    failure_kind: 'conversion',
    failure_code: 'CONVERSION_FAILED',
    manual_retry_count: 0,
    retained_until: null,
    created_at: new Date('2026-10-13T09:15:42.123Z'),
    cursor_created_at: CREATED_AT_TEXT,
    continues,
  };
}

async function list(continues: boolean, query: Readonly<Record<string, string>> = {}) {
  const calls: unknown[][] = [];
  const runtime = {
    pool: {
      query: (_sql: string, values: unknown[]) => {
        calls.push(values);
        return Promise.resolve({ rows: [row(continues)] });
      },
    },
  };
  const page = await createHandler(
    runtime as never,
    { id: 'm'.repeat(32) } as never,
  )({
    query: { roomId: ROOM_ID, ...query },
  } as never);
  return { page, calls };
}

describe('processing state paging', () => {
  it('issues the exact database timestamp as the cursor when a further page exists', async () => {
    const { page } = await list(true);
    expect(page.nextCursor).toStrictEqual({
      createdAt: CREATED_AT_TEXT,
      versionId: VERSION_ID,
    });
    expect(ajv.compile(schema.response[200])(page)).toBe(true);
  });

  it('issues no cursor on the last page', async () => {
    const { page } = await list(false);
    expect(page).not.toHaveProperty('nextCursor');
  });

  it('accepts the issued cursor back and passes it to the reader unmodified', async () => {
    const query = {
      roomId: ROOM_ID,
      afterCreatedAt: CREATED_AT_TEXT,
      afterVersionId: VERSION_ID,
    };
    expect(ajv.compile(schema.querystring)(query)).toBe(true);
    const { calls } = await list(false, query);
    expect(calls[0]?.slice(2, 4)).toStrictEqual([CREATED_AT_TEXT, VERSION_ID]);
  });

  it('refuses a cursor timestamp PostgreSQL could not cast, before it reaches the database', () => {
    const validate = ajv.compile(schema.querystring);
    const query = (afterCreatedAt: string) => ({
      roomId: ROOM_ID,
      afterCreatedAt,
      afterVersionId: VERSION_ID,
    });
    expect(validate(query(CREATED_AT_TEXT))).toBe(true);
    expect(validate(query('not a timestamp, padded long'))).toBe(false);
    expect(validate(query('2026-10-13 09:15:42.123456+00'))).toBe(false);
    expect(validate(query('2026-10-13T09:15:42.123Z'))).toBe(false);
    expect(validate(query('2026-10-13T09:15:42.1234567Z'))).toBe(false);
  });

  it('refuses half a cursor rather than paging from an incomplete position', () => {
    const validate = ajv.compile(schema.querystring);
    expect(validate({ roomId: ROOM_ID, afterCreatedAt: CREATED_AT_TEXT })).toBe(false);
    expect(validate({ roomId: ROOM_ID, afterVersionId: VERSION_ID })).toBe(false);
  });
});
