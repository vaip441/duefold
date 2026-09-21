/**
 * Member rooms: listing, workspace, structure, publication, trash, and search.
 *
 * Split out of api/client.ts, which had grown to hold every HTTP domain in one
 * file. The transport, CSRF handling, and failure classification stay shared in
 * transport.ts so there is exactly one place that talks to the network.
 */

import {
  ApiError,
  isRecord,
  json,
  requireArray,
  requireInteger,
  requireString,
} from './transport.ts';

export type RoomState = 'draft' | 'published' | 'archived';
export type RoomAccessSource = 'assignment' | 'global_role';
export type MemberRoomRole = 'manager' | 'contributor';

/**
 * WHY a room is reachable, as a discriminated union.
 *
 * The two fields are not independent. `read_member_rooms` derives the source from the
 * role — `CASE WHEN a.room_role IS NOT NULL THEN 'assignment' ELSE 'global_role' END`
 * (`006_member_workspace_readers.sql:96`) — so an assignment ALWAYS carries a role and a
 * role-derived reach NEVER does.
 *
 * Validating them separately admitted combinations the database cannot produce:
 * `{roomRole: null, accessSource: 'assignment'}` claims a colleague staffed this member
 * into a room in no stated role, and `{roomRole: 'manager', accessSource: 'global_role'}`
 * advertises a narrower explicit role on someone who actually holds standing Room Manager
 * authority everywhere. This surface EXPLAINS access from these fields, so either shape
 * renders a false statement about why a room can be opened. The union removes both from
 * the type rather than leaving them merely unexpected.
 */
export type RoomAccess =
  | { readonly accessSource: 'assignment'; readonly roomRole: MemberRoomRole }
  | { readonly accessSource: 'global_role'; readonly roomRole: null };

export type MemberRoom = {
  readonly roomId: string;
  readonly title: string;
  readonly description: string;
  readonly state: RoomState;
  readonly revision: number;
  readonly workingRevision: number;
  readonly publishedRevision: number;
  readonly canPublish: boolean;
} & RoomAccess;

export type PublicationChangeKind =
  'add' | 'remove' | 'rename' | 'move' | 'reorder' | 'description' | 'version' | 'replace';

interface EntryFacts {
  readonly entryId: string;
  readonly resourceId: string;
  readonly parentFolderId: string | null;
  readonly displayName: string;
  readonly description: string;
  /** The structure entry's revision, which structure mutations compare. */
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
export type FolderEntry = EntryFacts & {
  readonly resourceKind: 'folder';
  readonly documentRevision: null;
};
/** `documentRevision` is what document metadata and download policy writers compare. */
export type DocumentEntry = EntryFacts & {
  readonly resourceKind: 'document';
  readonly documentRevision: number;
};
export type WorkingEntry = FolderEntry | DocumentEntry;

const CHANGE_KINDS: readonly PublicationChangeKind[] = [
  'add',
  'remove',
  'rename',
  'move',
  'reorder',
  'description',
  'version',
  'replace',
];

function parseEntry(value: unknown): WorkingEntry {
  if (!isRecord(value)) throw new ApiError('unavailable');
  const changeKinds = requireArray(value, 'changeKinds');
  if (!changeKinds.every((kind) => (CHANGE_KINDS as readonly unknown[]).includes(kind)))
    throw new ApiError('unavailable');
  const parent = value['parentFolderId'];
  if (parent !== null && typeof parent !== 'string') throw new ApiError('unavailable');
  for (const key of [
    'stagedRemoved',
    'canMoveUp',
    'canMoveDown',
    'hasPublishableVersion',
    'isPublished',
  ])
    if (typeof value[key] !== 'boolean') throw new ApiError('unavailable');
  if (typeof value['description'] !== 'string') throw new ApiError('unavailable');
  const facts: EntryFacts = {
    entryId: requireString(value, 'entryId'),
    resourceId: requireString(value, 'resourceId'),
    parentFolderId: parent,
    displayName: requireString(value, 'displayName'),
    description: value['description'],
    revision: requireInteger(value, 'revision'),
    stagedRemoved: value['stagedRemoved'] as boolean,
    depth: requireInteger(value, 'depth'),
    position: requireInteger(value, 'position'),
    canMoveUp: value['canMoveUp'] as boolean,
    canMoveDown: value['canMoveDown'] as boolean,
    changeKinds: changeKinds as readonly PublicationChangeKind[],
    hasPublishableVersion: value['hasPublishableVersion'] as boolean,
    isPublished: value['isPublished'] as boolean,
  };
  /* A document carries its own revision and a folder has none, so the pair is the kind's
     discriminant rather than a nullable field beside it. */
  if (value['resourceKind'] === 'document')
    return {
      ...facts,
      resourceKind: 'document',
      documentRevision: requireInteger(value, 'documentRevision'),
    };
  if (value['resourceKind'] === 'folder' && value['documentRevision'] === null)
    return { ...facts, resourceKind: 'folder', documentRevision: null };
  throw new ApiError('unavailable');
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

/**
 * A keyset cursor over the room register. Echoed back unmodified.
 *
 * The server orders by `(title, roomId)`, so that pair is the key. Both components
 * travel together: half a key resumes at a position in neither ordering and would skip
 * or repeat rooms that share a title.
 */
export interface RoomCursor {
  readonly title: string;
  readonly roomId: string;
}

export interface RoomPage {
  readonly rooms: readonly MemberRoom[];
  /** Null when the server proved this page is the last one. */
  readonly nextCursor: RoomCursor | null;
}

const ROOM_STATES: readonly RoomState[] = ['draft', 'published', 'archived'];

/**
 * Parses the access provenance as ONE decision, not two independent fields.
 *
 * Checking them separately accepted pairings the reader cannot emit, and both of them
 * are false statements about why a room is reachable rather than merely odd data. This
 * returns the union member the pair names, or fails closed.
 */
function parseAccess(value: Readonly<Record<string, unknown>>): RoomAccess {
  const role = value['roomRole'];
  switch (value['accessSource']) {
    case 'assignment':
      /* A colleague staffed this member into the room, so a ROLE is what they were
         staffed as. Without one there is nothing the assignment could mean. */
      if (role !== 'manager' && role !== 'contributor') throw new ApiError('unavailable');
      return { accessSource: 'assignment', roomRole: role };
    case 'global_role':
      /* Reached through an organization role, which carries Room Manager authority in
         every room. An explicit role here would advertise something NARROWER than the
         authority actually held. */
      if (role !== null) throw new ApiError('unavailable');
      return { accessSource: 'global_role', roomRole: null };
    default:
      throw new ApiError('unavailable');
  }
}

/**
 * Parses one room, validating every field rather than casting the array.
 *
 * A blanket cast made the whole register whatever the server happened to send. That
 * matters here beyond hygiene: `roomRole` and `accessSource` are how the product
 * EXPLAINS why a room is reachable, and `canPublish` is a server decision the surface
 * echoes. A value this process does not recognize means the two disagree about the
 * vocabulary, and rendering it would state access or authority the server never
 * described. Fail closed instead.
 */
function parseRoom(value: unknown): MemberRoom {
  if (!isRecord(value)) throw new ApiError('unavailable');
  const state = value['state'];
  if (!(ROOM_STATES as readonly unknown[]).includes(state)) throw new ApiError('unavailable');
  if (typeof value['canPublish'] !== 'boolean') throw new ApiError('unavailable');
  if (typeof value['description'] !== 'string') throw new ApiError('unavailable');
  return {
    roomId: requireString(value, 'roomId'),
    title: requireString(value, 'title'),
    description: value['description'],
    state: state as RoomState,
    /* Revisions are the counters optimistic concurrency compares, so a fractional one is a
       malformed response rather than a stale expectation. */
    revision: requireInteger(value, 'revision'),
    workingRevision: requireInteger(value, 'workingRevision'),
    publishedRevision: requireInteger(value, 'publishedRevision'),
    /* One decision, so a contradictory pair cannot be assembled here. */
    ...parseAccess(value),
    canPublish: value['canPublish'],
  };
}

/**
 * One bounded page of the member's rooms (§23).
 *
 * `nextCursor` is the whole completeness contract. Rooms grow without an installation
 * cap and an Owner or Admin reaches all of them, so a caller that stops before following
 * the cursor holds a PREFIX. That is load-bearing wherever the register decides
 * staffing: a short room list would make "Not staffed" read as an answer about rooms it
 * never saw.
 */
export async function loadRooms(input?: {
  readonly after?: RoomCursor | null;
  readonly signal?: AbortSignal;
}): Promise<RoomPage> {
  const after = input?.after ?? null;
  const suffix =
    after === null
      ? ''
      : `?afterTitle=${encodeURIComponent(after.title)}` +
        `&afterRoomId=${encodeURIComponent(after.roomId)}`;
  const payload = await json({
    method: 'GET',
    path: `/api/rooms${suffix}`,
    ...(input?.signal === undefined ? {} : { signal: input.signal }),
  });
  const rooms = requireArray(payload, 'rooms').map(parseRoom);
  if (!isRecord(payload)) throw new ApiError('unavailable');
  const cursor = payload['nextCursor'];
  if (cursor === undefined) return { rooms, nextCursor: null };
  if (!isRecord(cursor)) throw new ApiError('unavailable');
  return {
    rooms,
    nextCursor: {
      title: requireString(cursor, 'title'),
      roomId: requireString(cursor, 'roomId'),
    },
  };
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
    entries: requireArray(payload, 'entries').map(parseEntry),
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

export interface NewRoom {
  readonly title: string;
  readonly description: string;
}

/** Creates a draft room. Text is sent as NFC; every other rule is `create_room`'s. */
export async function createRoom(room: NewRoom): Promise<{ readonly roomId: string }> {
  const payload = await json({
    method: 'POST',
    path: '/api/rooms',
    body: {
      title: room.title.normalize('NFC'),
      description: room.description.normalize('NFC'),
    },
  });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  return { roomId: requireString(payload, 'roomId') };
}

/** One register row by id; null when the room is not reachable, which includes unknown. */
export async function loadRoom(
  roomId: string,
  signal?: AbortSignal,
): Promise<MemberRoom | null> {
  const payload = await json({
    method: 'GET',
    path: `/api/rooms?roomId=${encodeURIComponent(roomId)}`,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  const rooms = requireArray(payload, 'rooms').map(parseRoom);
  if (rooms.length > 1) throw new ApiError('unavailable');
  return rooms[0] ?? null;
}
