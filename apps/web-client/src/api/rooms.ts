/**
 * Member rooms: listing, workspace, structure, publication, trash, and search.
 *
 * Split out of api/client.ts, which had grown to hold every HTTP domain in one
 * file. The transport, CSRF handling, and failure classification stay shared in
 * transport.ts so there is exactly one place that talks to the network.
 */

import { ApiError, isRecord, json, requireArray } from './transport.ts';

export type RoomState = 'draft' | 'published' | 'archived';
export type RoomAccessSource = 'assignment' | 'global_role';

export interface MemberRoom {
  readonly roomId: string;
  readonly title: string;
  readonly description: string;
  readonly state: RoomState;
  readonly revision: number;
  readonly workingRevision: number;
  readonly publishedRevision: number;
  readonly roomRole: 'manager' | 'contributor' | null;
  readonly accessSource: RoomAccessSource;
  readonly canPublish: boolean;
}

export type PublicationChangeKind =
  'add' | 'remove' | 'rename' | 'move' | 'reorder' | 'description' | 'version' | 'replace';

export interface WorkingEntry {
  readonly entryId: string;
  readonly resourceKind: 'folder' | 'document';
  readonly resourceId: string;
  readonly parentFolderId: string | null;
  readonly displayName: string;
  readonly description: string;
  readonly revision: number;
  readonly stagedRemoved: boolean;
  readonly depth: number;
  readonly position: number;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly changeKinds: readonly PublicationChangeKind[];
  readonly hasPublishableVersion: boolean;
  readonly isPublished: boolean;
}

export interface TrashEntry {
  readonly trashId: string;
  readonly resourceKind: 'folder' | 'document';
  readonly displayName: string;
  readonly rootEntryId: string;
  readonly entryRevision: number;
  readonly trashedAt: string;
  readonly purgeAfter: string;
  readonly wasPublished: boolean;
}

export interface RoomWorkspace {
  readonly entries: readonly WorkingEntry[];
  readonly trash: readonly TrashEntry[];
  readonly retentionDays: number;
}

export interface PublicationItem {
  readonly entryId: string;
  readonly path: string;
  readonly changes: readonly PublicationChangeKind[];
}

export interface PublicationImpact {
  readonly message: string;
  readonly affectedCount: number;
  readonly paths: readonly string[];
  readonly confirmation: string;
  readonly items: readonly PublicationItem[];
}

export interface SearchHit {
  readonly resourceKind: 'room' | 'folder' | 'document';
  readonly resourceId: string;
  readonly displayName: string;
  readonly description: string;
  readonly path: string;
}

export async function loadRooms(signal?: AbortSignal): Promise<readonly MemberRoom[]> {
  const payload = await json({
    method: 'GET',
    path: '/api/rooms',
    ...(signal === undefined ? {} : { signal }),
  });
  return requireArray(payload, 'rooms') as readonly MemberRoom[];
}

export async function loadRoomWorkspace(
  roomId: string,
  signal?: AbortSignal,
): Promise<RoomWorkspace> {
  const payload = await json({
    method: 'GET',
    path: `/api/rooms/workspace?roomId=${encodeURIComponent(roomId)}`,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!isRecord(payload) || typeof payload['retentionDays'] !== 'number')
    throw new ApiError('unavailable');
  return {
    entries: requireArray(payload, 'entries') as readonly WorkingEntry[],
    trash: requireArray(payload, 'trash') as readonly TrashEntry[],
    retentionDays: payload['retentionDays'],
  };
}

/** Structure mutations. The body is a discriminated union the server validates. */
export async function mutateStructure(body: Readonly<Record<string, unknown>>): Promise<void> {
  await json({ method: 'POST', path: '/api/rooms/structure', body });
}

export async function publicationDryRun(roomId: string): Promise<PublicationImpact> {
  const payload = await json({
    method: 'POST',
    path: '/api/rooms/actions',
    body: { action: 'publish-dry-run', roomId },
  });
  if (!isRecord(payload) || !isRecord(payload['impact'])) throw new ApiError('unavailable');
  const impact = payload['impact'];
  if (
    typeof impact['confirmation'] !== 'string' ||
    typeof impact['affectedCount'] !== 'number' ||
    typeof impact['message'] !== 'string'
  )
    throw new ApiError('unavailable');
  /*
   * FAIL CLOSED on a malformed impact. Substituting an empty array for absent
   * items, or casting them unchecked, let a schema drift render a confident
   * "publish N changes" with no per-item detail -- the precise false-confirmation
   * this preview exists to prevent. A count without its items is unusable, so an
   * inconsistent payload must surface as unavailable rather than as reassurance.
   */
  const rawItems = impact['items'];
  if (!Array.isArray(rawItems)) throw new ApiError('unavailable');
  const items = rawItems.map((entry): PublicationItem => {
    if (typeof entry !== 'object' || entry === null) throw new ApiError('unavailable');
    const record = entry as Record<string, unknown>;
    const changes = record['changes'];
    if (
      typeof record['entryId'] !== 'string' ||
      typeof record['path'] !== 'string' ||
      !Array.isArray(changes) ||
      changes.length === 0 ||
      !changes.every((value) => typeof value === 'string')
    )
      throw new ApiError('unavailable');
    return {
      entryId: record['entryId'],
      path: record['path'],
      changes: changes as readonly string[],
    } as PublicationItem;
  });
  if (impact['affectedCount'] !== items.length) throw new ApiError('unavailable');
  return {
    message: impact['message'],
    affectedCount: impact['affectedCount'],
    confirmation: impact['confirmation'],
    paths: Array.isArray(impact['paths']) ? (impact['paths'] as readonly string[]) : [],
    items,
  };
}

export async function publicationApply(input: {
  readonly roomId: string;
  readonly expectedWorkingRevision: number;
  readonly expectedPublishedRevision: number;
  readonly confirmation: string;
}): Promise<void> {
  await json({
    method: 'POST',
    path: '/api/rooms/actions',
    body: { action: 'publish-apply', ...input },
  });
}

export async function restoreFromTrash(input: {
  readonly trashId: string;
  readonly destinationFolderId: string | null;
  readonly displayName: string;
  readonly expectedEntryRevision: number;
  readonly expectedWorkingRevision: number;
}): Promise<void> {
  await json({
    method: 'POST',
    path: '/api/rooms/actions',
    body: { action: 'restore', ...input },
  });
}

export async function searchRoom(
  roomId: string,
  query: string,
  signal?: AbortSignal,
): Promise<readonly SearchHit[]> {
  const payload = await json({
    method: 'POST',
    path: '/api/rooms/actions',
    body: { action: 'search', roomId, query },
    ...(signal === undefined ? {} : { signal }),
  });
  return requireArray(payload, 'results') as readonly SearchHit[];
}

/*
 * ---------------------------------------------------------------------------
 * Viewer reading room
 *
 * Everything a viewer sees is what the server disclosed for that viewer's own
 * session. The client never filters a room, folder, document, or page for
 * itself: an entry absent from these responses is absent because the server
 * made an authorization decision, so there is no client-side list to leak an
 * inaccessible title, path, count, or peer.
 *
 * `downloadPolicy` is echoed from the server so the UI does not offer an action
 * the server would refuse. It is not a permission: the lease endpoint decides,
 * and every range request is re-authorized.
 * ---------------------------------------------------------------------------
 */
