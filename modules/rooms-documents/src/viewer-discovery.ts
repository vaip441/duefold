import type { Pool } from 'pg';
import type { ViewerIdentity } from '../../core-security/src/authorization.ts';

function sessionProof(identity: ViewerIdentity): string {
  if (identity.sessionProof === undefined) throw new Error('VIEWER_SESSION_PROOF_REQUIRED');
  return identity.sessionProof;
}

export interface ViewerRoom {
  readonly roomId: string;
  readonly title: string;
  readonly description: string;
}

export interface ViewerStructureEntry {
  readonly entryId: string;
  readonly resourceKind: 'folder' | 'document';
  readonly resourceId: string;
  readonly parentFolderId: string | null;
  readonly displayName: string;
  readonly description: string;
  readonly publishedVersionId: string | null;
  readonly siblingPosition: number;
}

export interface ViewerSearchResult {
  readonly resourceKind: 'folder' | 'document';
  readonly resourceId: string;
  readonly displayName: string;
  readonly description: string;
  readonly path: string;
}

export interface ViewerDocumentMetadata {
  readonly documentId: string;
  readonly displayTitle: string;
  readonly publishedVersionId: string;
  readonly pageCount: number;
  readonly downloadPolicy: 'allow' | 'deny';
}

export async function readViewerRooms(input: {
  readonly pool: Pool;
  readonly identity: ViewerIdentity;
}): Promise<readonly ViewerRoom[]> {
  const result = await input.pool.query<{
    room_id: string;
    title: string;
    description: string;
  }>('SELECT * FROM read_presented_viewer_rooms($1)', [sessionProof(input.identity)]);
  return result.rows.map((row) => ({
    roomId: row.room_id,
    title: row.title,
    description: row.description,
  }));
}

export async function readViewerStructure(input: {
  readonly pool: Pool;
  readonly identity: ViewerIdentity;
  readonly roomId: string;
}): Promise<readonly ViewerStructureEntry[]> {
  const result = await input.pool.query<{
    entry_id: string;
    resource_kind: 'folder' | 'document';
    resource_id: string;
    parent_folder_id: string | null;
    display_name: string;
    description: string;
    published_version_id: string | null;
    sibling_position: number;
  }>('SELECT * FROM read_presented_viewer_structure($1,$2)', [
    sessionProof(input.identity),
    input.roomId,
  ]);
  return result.rows.map((row) => ({
    entryId: row.entry_id,
    resourceKind: row.resource_kind,
    resourceId: row.resource_id,
    parentFolderId: row.parent_folder_id,
    displayName: row.display_name,
    description: row.description,
    publishedVersionId: row.published_version_id,
    siblingPosition: row.sibling_position,
  }));
}

export async function searchViewerStructure(input: {
  readonly pool: Pool;
  readonly identity: ViewerIdentity;
  readonly roomId: string;
  readonly query: string;
  readonly limit: number;
}): Promise<readonly ViewerSearchResult[]> {
  const result = await input.pool.query<{
    resource_kind: 'folder' | 'document';
    resource_id: string;
    display_name: string;
    description: string;
    path: string;
  }>('SELECT * FROM search_presented_viewer_structure($1,$2,$3,$4)', [
    sessionProof(input.identity),
    input.roomId,
    input.query,
    input.limit,
  ]);
  return result.rows.map((row) => ({
    resourceKind: row.resource_kind,
    resourceId: row.resource_id,
    displayName: row.display_name,
    description: row.description,
    path: row.path,
  }));
}

export async function readViewerDocumentMetadata(input: {
  readonly pool: Pool;
  readonly identity: ViewerIdentity;
  readonly roomId: string;
  readonly documentId: string;
}): Promise<ViewerDocumentMetadata | null> {
  const row = (
    await input.pool.query<{
      document_id: string;
      display_title: string;
      published_version_id: string;
      page_count: number;
      download_policy: 'allow' | 'deny';
    }>('SELECT * FROM read_presented_viewer_document_metadata($1,$2,$3)', [
      sessionProof(input.identity),
      input.roomId,
      input.documentId,
    ])
  ).rows[0];
  return row === undefined
    ? null
    : {
        documentId: row.document_id,
        displayTitle: row.display_title,
        publishedVersionId: row.published_version_id,
        pageCount: row.page_count,
        downloadPolicy: row.download_policy,
      };
}
