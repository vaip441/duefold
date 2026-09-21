/**
 * Member workspace reads.
 *
 * duefold_runtime holds no SELECT on room, folder, working_structure_entry,
 * published_structure_entry, or room_trash. Every read here goes through a
 * SECURITY DEFINER reader in migration 006 that authorizes internally with the
 * same member_can_mutate_room predicate the mutations use, so an unauthorized
 * actor receives zero rows rather than a filtered view assembled in this process.
 *
 * Nothing in these shapes carries an object key, sha256 digest, correlation id,
 * internal filename, or fractional order key. Ordering is a dense position with
 * neighbour facts, because leaking the fractional key would invite a client to
 * compute its own and post it.
 */
import type { Pool } from 'pg';
import type { MemberIdentity } from '../../core-security/src/authorization.ts';

/** Why a room is reachable. Never presented as an assignment when it is not. */
export type RoomAccessSource = 'assignment' | 'global_role';

export type PublicationChangeKind =
  'add' | 'remove' | 'rename' | 'move' | 'reorder' | 'description' | 'version' | 'replace';

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

function changeKinds(values: readonly string[]): readonly PublicationChangeKind[] {
  /*
   * FAIL CLOSED on an UNKNOWN kind: a value this client does not recognize means
   * the server and client disagree about the publication vocabulary, and filtering
   * it silently produced an item with a non-zero affected count and an incomplete
   * change list -- an unlabelled marker in the one preview a Manager relies on
   * before an irreversible publish.
   *
   * An EMPTY set is legitimate and must NOT throw: an unchanged entry genuinely
   * has no pending changes, and this reader projects the whole working tree, not
   * only the changed rows. Emptiness is enforced where it actually matters -- the
   * publication preview requires every listed item to carry at least one change.
   */
  const parsed: PublicationChangeKind[] = [];
  for (const value of values) {
    if (!(CHANGE_KINDS as readonly string[]).includes(value))
      throw new Error('PUBLICATION_CHANGE_KIND_UNKNOWN');
    parsed.push(value as PublicationChangeKind);
  }
  return parsed;
}

/**
 * WHY a room is reachable, as a discriminated union.
 *
 * `read_member_rooms` derives the source from the role —
 * `CASE WHEN a.room_role IS NOT NULL THEN 'assignment' ELSE 'global_role' END`
 * (`006_member_workspace_readers.sql:96`) — so the pair is one fact, not two. Typing them
 * independently let a contradictory pair type-check and serialize: an `assignment` with no
 * role claims a colleague staffed this member in no stated role, and a `global_role` with
 * an explicit role advertises something NARROWER than the standing Room Manager authority
 * that reach actually carries. The browser explains access from these fields, so either
 * one is a false statement rather than untidy data.
 */
export type RoomAccess =
  | { readonly accessSource: 'assignment'; readonly roomRole: 'manager' | 'contributor' }
  | { readonly accessSource: 'global_role'; readonly roomRole: null };

export type MemberRoom = {
  readonly roomId: string;
  readonly title: string;
  readonly description: string;
  readonly state: 'draft' | 'published' | 'archived';
  readonly revision: number;
  readonly workingRevision: number;
  readonly publishedRevision: number;
  /** Server's decision, not a client inference. Manager-only actions honour it. */
  readonly canPublish: boolean;
} & RoomAccess;

interface MemberRoomRow {
  readonly room_id: string;
  readonly title: string;
  readonly description: string;
  readonly state: 'draft' | 'published' | 'archived';
  readonly revision: number;
  readonly working_revision: number;
  readonly published_revision: number;
  readonly room_role: 'manager' | 'contributor' | null;
  readonly access_source: RoomAccessSource;
  readonly can_publish: boolean;
  /** Whether further rooms remain, stated by the reader rather than inferred. */
  readonly continues: boolean;
}

/**
 * A keyset cursor over the room register.
 *
 * `read_member_rooms` orders by `(title, id)`, so that pair is the cursor. Both
 * components travel together; a partial one is refused rather than guessed at, because
 * resuming from half a key would skip or repeat rooms sharing a title.
 */
export interface MemberRoomCursor {
  readonly title: string;
  readonly roomId: string;
}

export interface MemberRoomPage {
  readonly rooms: readonly MemberRoom[];
  /** Absent when this page is provably the last one. */
  readonly nextCursor?: MemberRoomCursor;
}

/**
 * Reads one row's access provenance as the single fact it is.
 *
 * The reader derives both fields from `a.room_role IS NOT NULL`, so a row whose pair
 * disagrees means PostgreSQL and this process disagree about the vocabulary. Passing it
 * through would let the browser explain access with a statement the database never made,
 * so it fails closed like every other unrecognized value in this layer.
 *
 * `access_source` is already narrowed by `MemberRoomRow`, so the switch is exhaustive and
 * the ROLE is what each branch has to check: those are the pairings a flat shape admitted.
 */
function roomAccess(row: Omit<MemberRoomRow, 'continues'>): RoomAccess {
  switch (row.access_source) {
    case 'assignment':
      /* Staffed by a colleague, so the role they were staffed as must be present. */
      if (row.room_role === null) throw new Error('ROOM_ACCESS_SOURCE_CONTRADICTORY');
      return { accessSource: 'assignment', roomRole: row.room_role };
    case 'global_role':
      /* An organization role carries Room Manager authority everywhere, so an explicit
         role here would advertise something narrower than the authority held. */
      if (row.room_role !== null) throw new Error('ROOM_ACCESS_SOURCE_CONTRADICTORY');
      return { accessSource: 'global_role', roomRole: null };
  }
}

function toMemberRoom(row: Omit<MemberRoomRow, 'continues'>): MemberRoom {
  return {
    roomId: row.room_id,
    title: row.title,
    description: row.description,
    state: row.state,
    revision: row.revision,
    workingRevision: row.working_revision,
    publishedRevision: row.published_revision,
    /* One decision, so a contradictory pair cannot be assembled here. */
    ...roomAccess(row),
    canPublish: row.can_publish,
  };
}

/** One register row, or null when the room is unreachable or unknown — the two are not told apart. */
export async function readMemberRoom(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
}): Promise<MemberRoom | null> {
  const result = await input.pool.query<Omit<MemberRoomRow, 'continues'>>(
    'SELECT * FROM read_member_room($1,$2)',
    [input.identity.id, input.roomId],
  );
  const row = result.rows[0];
  return row === undefined ? null : toMemberRoom(row);
}

/** Rooms one page carries. An Owner or Admin sees every room, so this is bounded (§23). */
export const ROOM_PAGE_LIMIT = 50;
export const MAX_ROOM_PAGE_LIMIT = 100;

/**
 * One bounded page of the member's rooms.
 *
 * Rooms are a growing collection with no installation cap and an Owner or Admin reaches
 * all of them, so an unbounded projection was a response and a render that grew without
 * limit. It also left every consumer unable to tell a complete set from a truncated one,
 * which matters most where the register is used to decide staffing: a room list that was
 * silently short would make "Not staffed" read as an answer about rooms it never saw.
 *
 * The cursor and the limit are passed INTO `read_member_rooms` rather than wrapped
 * around it. PostgreSQL does not inline a SECURITY DEFINER function, so an outer
 * WHERE/LIMIT could not be pushed down: every page materialized the whole register and
 * evaluated `member_can_mutate_room` twice per room, making a full walk quadratic. The
 * reader now stops after at most `limit + 1` rows.
 *
 * That extra probe row is the reader's own business -- it proves a further page exists
 * and is never returned -- because offering a cursor whenever a page was merely full
 * advertised another page for any register whose size is an exact multiple of the limit.
 */
export async function readMemberRooms(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly after?: MemberRoomCursor | null;
  readonly limit?: number;
}): Promise<MemberRoomPage> {
  const limit = input.limit ?? ROOM_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ROOM_PAGE_LIMIT)
    throw new Error('ROOM_PAGE_LIMIT_REJECTED');
  const after = input.after ?? null;
  const result = await input.pool.query<MemberRoomRow>(
    'SELECT * FROM read_member_rooms($1,$2,$3,$4)',
    [input.identity.id, after?.title ?? null, after?.roomId ?? null, limit],
  );
  const rooms = result.rows.map(toMemberRoom);
  const last = result.rows.at(-1);
  return {
    rooms,
    ...(last?.continues === true
      ? { nextCursor: { title: last.title, roomId: last.room_id } }
      : {}),
  };
}

export interface WorkingStructureEntry {
  readonly entryId: string;
  readonly resourceKind: 'folder' | 'document';
  readonly resourceId: string;
  readonly parentFolderId: string | null;
  readonly displayName: string;
  readonly description: string;
  readonly revision: number;
  readonly documentRevision: number | null;
  readonly stagedRemoved: boolean;
  readonly depth: number;
  readonly position: number;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  /** Empty when publishing this entry would change nothing viewers can see. */
  readonly changeKinds: readonly PublicationChangeKind[];
  readonly hasPublishableVersion: boolean;
  readonly isPublished: boolean;
}

interface WorkingStructureRow {
  readonly entry_id: string;
  readonly resource_kind: 'folder' | 'document';
  readonly resource_id: string;
  readonly parent_folder_id: string | null;
  readonly display_name: string;
  readonly description: string | null;
  readonly revision: number;
  readonly document_revision: number | null;
  readonly staged_removed: boolean;
  readonly depth: number;
  readonly sibling_position: number;
  readonly can_move_up: boolean;
  readonly can_move_down: boolean;
  readonly change_kinds: readonly string[];
  readonly has_publishable_version: boolean;
  readonly is_published: boolean;
}

export async function readWorkingStructure(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
}): Promise<readonly WorkingStructureEntry[]> {
  const result = await input.pool.query<WorkingStructureRow>(
    'SELECT * FROM read_member_working_structure($1,$2)',
    [input.identity.id, input.roomId],
  );
  return result.rows.map((row) => ({
    entryId: row.entry_id,
    resourceKind: row.resource_kind,
    resourceId: row.resource_id,
    parentFolderId: row.parent_folder_id,
    displayName: row.display_name,
    description: row.description ?? '',
    revision: row.revision,
    documentRevision: row.document_revision,
    stagedRemoved: row.staged_removed,
    depth: row.depth,
    position: row.sibling_position,
    canMoveUp: row.can_move_up,
    canMoveDown: row.can_move_down,
    changeKinds: changeKinds(row.change_kinds),
    hasPublishableVersion: row.has_publishable_version,
    isPublished: row.is_published,
  }));
}

export interface TrashEntry {
  readonly trashId: string;
  readonly resourceKind: 'folder' | 'document';
  readonly displayName: string;
  readonly rootEntryId: string;
  readonly entryRevision: number;
  /** ISO server timestamps. The client never computes retention from its clock. */
  readonly trashedAt: string;
  readonly purgeAfter: string;
  readonly wasPublished: boolean;
}

interface TrashRow {
  readonly trash_id: string;
  readonly resource_kind: 'folder' | 'document';
  readonly display_name: string;
  readonly root_entry_id: string;
  readonly entry_revision: number;
  readonly trashed_at: Date;
  readonly purge_after: Date;
  readonly was_published: boolean;
}

export async function readTrash(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
}): Promise<readonly TrashEntry[]> {
  const result = await input.pool.query<TrashRow>('SELECT * FROM read_member_trash($1,$2)', [
    input.identity.id,
    input.roomId,
  ]);
  return result.rows.map((row) => ({
    trashId: row.trash_id,
    resourceKind: row.resource_kind,
    displayName: row.display_name,
    rootEntryId: row.root_entry_id,
    entryRevision: row.entry_revision,
    trashedAt: row.trashed_at.toISOString(),
    purgeAfter: row.purge_after.toISOString(),
    wasPublished: row.was_published,
  }));
}
