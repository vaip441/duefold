import type { Pool } from 'pg';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import type { MemberIdentity } from '../../core-security/src/authorization.ts';
import { parseTextLayer, type ProtectedTextLayer } from './protected-delivery.ts';
import type { DeliveryStorage } from './storage/s3-compatible.ts';
import type { ViewerDocumentMetadata, ViewerStructureEntry } from './viewer-discovery.ts';

export interface PreviewRoom {
  readonly title: string;
  readonly state: 'draft' | 'published' | 'archived';
  readonly entries: readonly ViewerStructureEntry[];
}

interface Target {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
}
interface PageTarget extends Target {
  readonly documentId: string;
  readonly pageNumber: number;
}

export async function readPreviewRoom(input: Target): Promise<PreviewRoom> {
  const result = await input.pool.query<{ room: PreviewRoom | null }>(
    'SELECT read_member_preview_room($1,$2) room',
    [input.identity.id, input.roomId],
  );
  const room = result.rows[0]?.room ?? null;
  if (room === null) throw new Error('PROTECTED_PAGE_UNAVAILABLE');
  return room;
}

export async function readPreviewDocument(
  input: Target & { readonly documentId: string },
): Promise<ViewerDocumentMetadata | null> {
  const result = await input.pool.query<{
    document_id: string;
    display_title: string;
    published_version_id: string;
    page_count: number;
    download_policy: 'allow' | 'deny';
  }>('SELECT * FROM read_member_preview_document($1,$2,$3,$4,$5)', [
    input.identity.id,
    input.roomId,
    input.documentId,
    createOpaqueId(),
    createCorrelationId(),
  ]);
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    documentId: row.document_id,
    displayTitle: row.display_title,
    publishedVersionId: row.published_version_id,
    pageCount: row.page_count,
    downloadPolicy: row.download_policy,
  };
}

async function readPage(input: PageTarget) {
  const row = (
    await input.pool.query<{
      version_id: string;
      object_key: string;
      media_type: 'image/png' | 'image/webp';
      accessible_label: string;
      text_layer: unknown;
    }>('SELECT * FROM read_member_preview_page($1,$2,$3,$4)', [
      input.identity.id,
      input.roomId,
      input.documentId,
      input.pageNumber,
    ])
  ).rows[0];
  if (row === undefined) throw new Error('PROTECTED_PAGE_UNAVAILABLE');
  return row;
}

export async function readPreviewPageImage(
  input: PageTarget & { readonly storage: DeliveryStorage },
): Promise<{ readonly bytes: Uint8Array; readonly mediaType: 'image/png' | 'image/webp' }> {
  const page = await readPage(input);
  return {
    bytes: await input.storage.getObjectBytes(page.object_key),
    mediaType: page.media_type,
  };
}

/** Links are dropped: preview never offers a way out of the document. */
export async function readPreviewTextLayer(input: PageTarget): Promise<ProtectedTextLayer> {
  const page = await readPage(input);
  return {
    versionId: page.version_id,
    accessibleLabel: page.accessible_label,
    items: parseTextLayer(page.text_layer).map((item) => ({
      text: item.text,
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
    })),
  };
}
