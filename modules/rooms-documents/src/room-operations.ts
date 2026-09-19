import type { Pool } from 'pg';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import type { MemberIdentity } from '../../core-security/src/authorization.ts';
import { hasFreshOidc } from '../../core-security/src/authorization.ts';
import { validateStructureName } from './structure.ts';
import {
  MAX_DIRECTORY_FILES,
  MAX_DIRECTORY_TOTAL_BYTES,
  MAX_DIRECTORY_LEVELS,
} from './resource-policy.ts';

export const TRASH_RETENTION_DAYS = 30;
export const MAX_SEARCH_QUERY_CODE_POINTS = 200;
export const MAX_SEARCH_RESULTS = 100;
export const MAX_BULK_ITEMS = 1_000;

export interface SearchResult {
  readonly resourceKind: 'room' | 'folder' | 'document';
  readonly resourceId: string;
  readonly displayName: string;
  readonly description: string;
  readonly path: string;
}

interface SearchRow {
  readonly resource_kind: 'room' | 'folder' | 'document';
  readonly resource_id: string;
  readonly display_name: string;
  readonly description: string;
  readonly path: string;
}

function validateSearch(query: string, limit: number): void {
  const length = Array.from(query).length;
  if (
    length < 1 ||
    length > MAX_SEARCH_QUERY_CODE_POINTS ||
    limit < 1 ||
    limit > MAX_SEARCH_RESULTS
  )
    throw new Error('SEARCH_BOUNDS_REJECTED');
}
function rows(rows: readonly SearchRow[]): readonly SearchResult[] {
  return rows.map((row) => ({
    resourceKind: row.resource_kind,
    resourceId: row.resource_id,
    displayName: row.display_name,
    description: row.description,
    path: row.path,
  }));
}

export async function searchMemberRoom(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
  readonly query: string;
  readonly limit?: number;
}): Promise<readonly SearchResult[]> {
  const limit = input.limit ?? 50;
  validateSearch(input.query, limit);
  const result = await input.pool.query<SearchRow>(
    'SELECT * FROM member_search_room($1,$2,$3,$4)',
    [input.identity.id, input.roomId, input.query, limit],
  );
  return rows(result.rows);
}

export async function restoreTrash(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly trashId: string;
  readonly destinationFolderId: string | null;
  readonly displayName: string;
  readonly orderKey: number;
  readonly expectedEntryRevision: number;
  readonly expectedWorkingRevision: number;
}): Promise<{ readonly entryRevision: number; readonly workingRevision: number }> {
  validateStructureName(input.displayName);
  const result = await input.pool.query<{ entry_revision: number; working_revision: number }>(
    'SELECT * FROM restore_trash_entry($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [
      input.trashId,
      input.destinationFolderId,
      input.displayName,
      input.orderKey,
      input.identity.id,
      input.expectedEntryRevision,
      input.expectedWorkingRevision,
      createOpaqueId(),
      createCorrelationId(),
    ],
  );
  const restored = result.rows[0];
  if (restored === undefined) throw new Error('TRASH_RESTORE_FAILED');
  return { entryRevision: restored.entry_revision, workingRevision: restored.working_revision };
}

export interface BulkMoveItem {
  readonly entryId: string;
  readonly expectedEntryRevision: number;
  readonly orderKey: number;
}
export interface BulkImpact {
  readonly message: string;
  readonly affectedCount: number;
  readonly paths: readonly string[];
  readonly confirmation: string;
}
export interface BulkItemResult {
  readonly entryId: string;
  readonly status: 'moved' | 'published';
}
function moveJson(items: readonly BulkMoveItem[]): readonly Record<string, string | number>[] {
  if (items.length < 1 || items.length > MAX_BULK_ITEMS)
    throw new Error('BULK_ITEM_BOUND_EXCEEDED');
  return items.map((item) => ({
    entryId: item.entryId,
    expectedEntryRevision: item.expectedEntryRevision,
    orderKey: item.orderKey,
  }));
}
export async function dryRunBulkMove(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
  readonly destinationFolderId: string | null;
  readonly items: readonly BulkMoveItem[];
}): Promise<BulkImpact> {
  const result = await input.pool.query<{ dry_run_bulk_move: BulkImpact }>(
    'SELECT dry_run_bulk_move($1,$2,$3,$4::jsonb)',
    [
      input.identity.id,
      input.roomId,
      input.destinationFolderId,
      JSON.stringify(moveJson(input.items)),
    ],
  );
  const impact = result.rows[0]?.dry_run_bulk_move;
  if (impact === undefined) throw new Error('BULK_DRY_RUN_FAILED');
  return impact;
}
export async function applyBulkMove(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
  readonly destinationFolderId: string | null;
  readonly items: readonly BulkMoveItem[];
  readonly expectedWorkingRevision: number;
  readonly confirmation: string;
}): Promise<{ readonly workingRevision: number; readonly items: readonly BulkItemResult[] }> {
  const result = await input.pool.query<{
    apply_bulk_move: { workingRevision: number; items: readonly BulkItemResult[] };
  }>('SELECT apply_bulk_move($1,$2,$3,$4::jsonb,$5,$6,$7,$8)', [
    input.identity.id,
    input.roomId,
    input.destinationFolderId,
    JSON.stringify(moveJson(input.items)),
    input.expectedWorkingRevision,
    input.confirmation,
    createOpaqueId(),
    createCorrelationId(),
  ]);
  const applied = result.rows[0]?.apply_bulk_move;
  if (applied === undefined) throw new Error('BULK_MOVE_FAILED');
  return applied;
}
export async function dryRunBulkPublish(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
}): Promise<BulkImpact> {
  const result = await input.pool.query<{ dry_run_bulk_publish: BulkImpact }>(
    'SELECT dry_run_bulk_publish($1,$2)',
    [input.identity.id, input.roomId],
  );
  const impact = result.rows[0]?.dry_run_bulk_publish;
  if (impact === undefined) throw new Error('BULK_DRY_RUN_FAILED');
  return impact;
}
export async function applyBulkPublish(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
  readonly expectedWorkingRevision: number;
  readonly expectedPublishedRevision: number;
  readonly confirmation: string;
  readonly now?: Date;
}): Promise<{ readonly publishedRevision: number; readonly items: readonly BulkItemResult[] }> {
  const now = input.now ?? new Date();
  if (!hasFreshOidc(input.identity.oidcAuthenticatedAt, now))
    throw new Error('FRESH_OIDC_REQUIRED');
  const result = await input.pool.query<{
    apply_bulk_publish: { publishedRevision: number; items: readonly BulkItemResult[] };
  }>('SELECT apply_bulk_publish($1,$2,$3,$4,$5,$6,$7,$8)', [
    input.identity.id,
    input.roomId,
    input.expectedWorkingRevision,
    input.expectedPublishedRevision,
    input.identity.oidcAuthenticatedAt,
    input.confirmation,
    createOpaqueId(),
    createCorrelationId(),
  ]);
  const applied = result.rows[0]?.apply_bulk_publish;
  if (applied === undefined) throw new Error('BULK_PUBLISH_FAILED');
  return applied;
}

export interface BulkUploadPlanItem {
  readonly path: string;
  readonly sizeBytes: number;
}
export function validateBulkUploadPlan(items: readonly BulkUploadPlanItem[]): void {
  if (items.length < 1 || items.length > MAX_DIRECTORY_FILES)
    throw new Error('DIRECTORY_FILE_COUNT_REJECTED');
  let total = 0;
  for (const item of items) {
    const segments = item.path.normalize('NFC').split('/');
    if (
      segments.length < 1 ||
      segments.length > MAX_DIRECTORY_LEVELS + 1 ||
      segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
    )
      throw new Error('DIRECTORY_PATH_REJECTED');
    validateStructureName(segments.at(-1) ?? '');
    if (!Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 1)
      throw new Error('DIRECTORY_SIZE_REJECTED');
    total += item.sizeBytes;
    if (total > MAX_DIRECTORY_TOTAL_BYTES) throw new Error('DIRECTORY_AGGREGATE_REJECTED');
  }
}
