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

export interface MemberRoom {
  readonly roomId: string;
  readonly title: string;
  readonly description: string;
  readonly state: 'draft' | 'published' | 'archived';
  readonly revision: number;
  readonly workingRevision: number;
  readonly publishedRevision: number;
  readonly roomRole: 'manager' | 'contributor' | null;
  readonly accessSource: RoomAccessSource;
  /** Server's decision, not a client inference. Manager-only actions honour it. */
  readonly canPublish: boolean;
}

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
}

export async function readMemberRooms(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
}): Promise<readonly MemberRoom[]> {
  const result = await input.pool.query<MemberRoomRow>('SELECT * FROM read_member_rooms($1)', [
    input.identity.id,
  ]);
  return result.rows.map((row) => ({
    roomId: row.room_id,
    title: row.title,
    description: row.description,
    state: row.state,
    revision: row.revision,
    workingRevision: row.working_revision,
    publishedRevision: row.published_revision,
    roomRole: row.room_role,
    accessSource: row.access_source,
    canPublish: row.can_publish,
  }));
}

export interface WorkingStructureEntry {
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
