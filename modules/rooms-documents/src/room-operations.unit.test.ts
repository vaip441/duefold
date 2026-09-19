import { describe, expect, it } from 'vitest';
import {
  MAX_BULK_ITEMS,
  MAX_SEARCH_QUERY_CODE_POINTS,
  TRASH_RETENTION_DAYS,
  validateBulkUploadPlan,
} from './room-operations.ts';
import { MAX_DIRECTORY_FILES, MAX_DIRECTORY_TOTAL_BYTES } from './resource-policy.ts';

describe('room operation fixed policies', () => {
  it('keeps trash, search, and batch limits fixed in code', () => {
    expect(TRASH_RETENTION_DAYS).toBe(30);
    expect(MAX_SEARCH_QUERY_CODE_POINTS).toBe(200);
    expect(MAX_BULK_ITEMS).toBe(1_000);
  });

  it('accepts legitimate multi-script bulk paths and exact binding bounds', () => {
    expect(() => {
      validateBulkUploadPlan([
        { path: 'Eesti/Résumé financier (2026).pdf', sizeBytes: 1 },
        { path: 'Кириллица/Доходы 2026 (финал).pdf', sizeBytes: 1 },
        { path: '日本語/投資家向け資料.pdf', sizeBytes: 1 },
      ]);
    }).not.toThrow();
    expect(() => {
      validateBulkUploadPlan(
        Array.from({ length: MAX_DIRECTORY_FILES }, (_, index) => ({
          path: `Q4/file-${index}.pdf`,
          sizeBytes: Math.floor(MAX_DIRECTORY_TOTAL_BYTES / MAX_DIRECTORY_FILES),
        })),
      );
    }).not.toThrow();
  });

  it('rejects one file or byte beyond the fixed directory limits', () => {
    expect(() => {
      validateBulkUploadPlan(
        Array.from({ length: MAX_DIRECTORY_FILES + 1 }, (_, index) => ({
          path: `file-${index}.pdf`,
          sizeBytes: 1,
        })),
      );
    }).toThrow('DIRECTORY_FILE_COUNT_REJECTED');
    expect(() => {
      validateBulkUploadPlan([
        { path: 'large.pdf', sizeBytes: MAX_DIRECTORY_TOTAL_BYTES },
        { path: 'one-more.pdf', sizeBytes: 1 },
      ]);
    }).toThrow('DIRECTORY_AGGREGATE_REJECTED');
  });
});
