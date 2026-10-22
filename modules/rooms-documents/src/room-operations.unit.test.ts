import { describe, expect, it } from 'vitest';
import {
  MAX_BULK_ITEMS,
  MAX_SEARCH_QUERY_CODE_POINTS,
  TRASH_RETENTION_DAYS,
} from './room-operations.ts';

describe('room operation fixed policies', () => {
  it('keeps trash, search, and batch limits fixed in code', () => {
    expect(TRASH_RETENTION_DAYS).toBe(30);
    expect(MAX_SEARCH_QUERY_CODE_POINTS).toBe(200);
    expect(MAX_BULK_ITEMS).toBe(1_000);
  });
});
