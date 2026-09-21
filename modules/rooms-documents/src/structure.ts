import type { Pool } from 'pg';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import type { MemberIdentity } from '../../core-security/src/authorization.ts';

export const MAX_FOLDER_DEPTH = 5;
export const MAX_STRUCTURE_NAME_LENGTH = 200;
export const MAX_STRUCTURE_DESCRIPTION_LENGTH = 4000;
export const MAX_REBALANCE_SIBLINGS = 1000;
function containsForbiddenPlainText(value: string): boolean {
  return (
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13;
    }) || value.includes('\u007f')
  );
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

export function validateStructureName(value: string): void {
  const length = codePointLength(value);
  if (
    length < 1 ||
    length > MAX_STRUCTURE_NAME_LENGTH ||
    value !== value.normalize('NFC') ||
    value.trim().length < 1 ||
    containsForbiddenPlainText(value)
  )
    throw new Error('STRUCTURE_NAME_REJECTED');
}

export function validateStructureDescription(value: string): void {
  if (
    codePointLength(value) > MAX_STRUCTURE_DESCRIPTION_LENGTH ||
    value !== value.normalize('NFC') ||
    containsForbiddenPlainText(value)
  )
    throw new Error('STRUCTURE_DESCRIPTION_REJECTED');
}

export interface StructureRevision {
  readonly workingRevision: number;
}
export interface EntryRevision extends StructureRevision {
  readonly entryRevision: number;
}
export interface DocumentRevision extends StructureRevision {
  readonly documentRevision: number;
}

function parameters(identity: MemberIdentity): readonly [string, string, string] {
  return [identity.id, createOpaqueId(), createCorrelationId()];
}

export async function createRoom(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly title: string;
  readonly description: string;
}): Promise<{ readonly roomId: string }> {
  const roomId = createOpaqueId();
  await input.pool.query('SELECT create_room($1,$2,$3,$4,$5,$6)', [
    roomId,
    input.title,
    input.description,
    ...parameters(input.identity),
  ]);
  return { roomId };
}

export async function createFolder(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
  readonly parentFolderId?: string;
  readonly displayName: string;
  readonly description: string;
  readonly orderKey: number;
  readonly expectedWorkingRevision: number;
}): Promise<{ readonly folderId: string; readonly workingRevision: number }> {
  validateStructureName(input.displayName);
  validateStructureDescription(input.description);
  const folderId = createOpaqueId();
  const result = await input.pool.query<{ create_folder_entry: number }>(
    'SELECT create_folder_entry($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [
      folderId,
      input.roomId,
      input.parentFolderId ?? null,
      input.displayName,
      input.description,
      input.orderKey,
      input.identity.id,
      input.expectedWorkingRevision,
      createOpaqueId(),
      createCorrelationId(),
    ],
  );
  const revision = result.rows[0]?.create_folder_entry;
  if (revision === undefined) throw new Error('STRUCTURE_MUTATION_FAILED');
  return { folderId, workingRevision: revision };
}

export async function createDocumentEntry(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly documentId: string;
  readonly parentFolderId?: string;
  readonly displayName: string;
  readonly orderKey: number;
  readonly expectedWorkingRevision: number;
}): Promise<{ readonly entryId: string; readonly workingRevision: number }> {
  validateStructureName(input.displayName);
  const entryId = createOpaqueId();
  const result = await input.pool.query<{ create_document_entry: number }>(
    'SELECT create_document_entry($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [
      entryId,
      input.documentId,
      input.parentFolderId ?? null,
      input.displayName,
      input.orderKey,
      input.identity.id,
      input.expectedWorkingRevision,
      createOpaqueId(),
      createCorrelationId(),
    ],
  );
  const revision = result.rows[0]?.create_document_entry;
  if (revision === undefined) throw new Error('STRUCTURE_MUTATION_FAILED');
  return { entryId, workingRevision: revision };
}

export async function updateFolderDescription(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly folderId: string;
  readonly description: string;
  readonly expectedEntryRevision: number;
  readonly expectedWorkingRevision: number;
}): Promise<EntryRevision> {
  validateStructureDescription(input.description);
  const result = await input.pool.query<{ entry_revision: number; working_revision: number }>(
    'SELECT * FROM update_folder_description($1,$2,$3,$4,$5,$6,$7)',
    [
      input.folderId,
      input.description,
      input.identity.id,
      input.expectedEntryRevision,
      input.expectedWorkingRevision,
      createOpaqueId(),
      createCorrelationId(),
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('METADATA_MUTATION_FAILED');
  return { entryRevision: row.entry_revision, workingRevision: row.working_revision };
}

export async function rebalanceSiblings(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
  readonly parentFolderId?: string;
  readonly expectedWorkingRevision: number;
}): Promise<StructureRevision> {
  const result = await input.pool.query<{ rebalance_structure_siblings: number }>(
    'SELECT rebalance_structure_siblings($1,$2,$3,$4,$5,$6)',
    [
      input.roomId,
      input.parentFolderId ?? null,
      input.identity.id,
      input.expectedWorkingRevision,
      createOpaqueId(),
      createCorrelationId(),
    ],
  );
  const revision = result.rows[0]?.rebalance_structure_siblings;
  if (revision === undefined) throw new Error('STRUCTURE_MUTATION_FAILED');
  return { workingRevision: revision };
}

export function fractionalOrderKey(
  before: number | undefined,
  after: number | undefined,
): number {
  if (before === undefined && after === undefined) return 1024;
  if (before === undefined) {
    if (after === undefined || after <= 1) throw new Error('ORDER_REBALANCE_REQUIRED');
    return after / 2;
  }
  if (after === undefined) return before + 1024;
  if (!(before > 0 && after > before)) throw new Error('ORDER_BOUNDS_INVALID');
  const key = before + (after - before) / 2;
  if (key === before || key === after) throw new Error('ORDER_REBALANCE_REQUIRED');
  return key;
}

export async function mutateEntry(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly entryId: string;
  readonly parentFolderId?: string;
  readonly displayName: string;
  readonly orderKey: number;
  readonly stagedRemoved: boolean;
  readonly expectedEntryRevision: number;
  readonly expectedWorkingRevision: number;
}): Promise<EntryRevision> {
  validateStructureName(input.displayName);
  const result = await input.pool.query<{ entry_revision: number; working_revision: number }>(
    'SELECT * FROM mutate_structure_entry($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [
      input.entryId,
      input.parentFolderId ?? null,
      input.displayName,
      input.orderKey,
      input.stagedRemoved,
      input.identity.id,
      input.expectedEntryRevision,
      input.expectedWorkingRevision,
      createOpaqueId(),
      createCorrelationId(),
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('STRUCTURE_MUTATION_FAILED');
  return { entryRevision: row.entry_revision, workingRevision: row.working_revision };
}

export async function updateDocumentMetadata(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly documentId: string;
  readonly title: string;
  readonly description: string;
  readonly workingVersionId?: string;
  readonly expectedDocumentRevision: number;
  readonly expectedWorkingRevision: number;
}): Promise<DocumentRevision> {
  validateStructureName(input.title);
  validateStructureDescription(input.description);
  const result = await input.pool.query<{
    document_revision: number;
    working_revision: number;
  }>('SELECT * FROM update_document_metadata($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
    input.documentId,
    input.title,
    input.description,
    input.workingVersionId ?? null,
    input.identity.id,
    input.expectedDocumentRevision,
    input.expectedWorkingRevision,
    createOpaqueId(),
    createCorrelationId(),
  ]);
  const row = result.rows[0];
  if (row === undefined) throw new Error('METADATA_MUTATION_FAILED');
  return { documentRevision: row.document_revision, workingRevision: row.working_revision };
}
