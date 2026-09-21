/** Pure derivations for the Settings section, kept testable without a DOM. */
import type { DownloadPolicy, RoomSettings } from '../api/client.ts';
import type { MessageKey } from '../i18n/translate.ts';
import type { Load } from './state.ts';

const LIVE_PURGE = new Set(['scheduled', 'marker_pending', 'purging']);

/** Why a visibility control the member might expect is absent, stated from server facts. */
export function visibilityNotes(settings: RoomSettings): readonly MessageKey[] {
  const notes: MessageKey[] = [];
  if (settings.state === 'draft' && settings.publishedRevision === 0)
    notes.push('settings.visibility.publishStructureFirst');
  if (
    settings.state === 'archived' &&
    settings.purge !== null &&
    LIVE_PURGE.has(settings.purge.state)
  )
    notes.push('settings.visibility.pinnedByPurge');
  return notes;
}

/** The policy a document without its own exception resolves to (§9.3). */
export function roomDownloadPolicy(settings: RoomSettings): DownloadPolicy {
  return settings.downloadPolicy ?? settings.installationDownloadPolicy;
}

/**
 * Which read a keyed reader should show for the room now being asked about.
 *
 * Extracted from the hooks because this is where their bugs live, and a hook cannot be tested
 * here: the unit project runs in Node with no DOM and adding a renderer is not an option.
 * Both `useOpenRoom` and `useRoomSettings` hold at most one read, tagged with the room it
 * describes, and must answer `loading` — never the other room's value — whenever the tag does
 * not match. A late response for a room the member has left is therefore discarded rather
 * than shown against the room they are looking at.
 */
export function readFor<T>(
  read: { readonly roomId: string; readonly load: Load<T> } | null,
  roomId: string | null,
): Load<T> | null {
  if (roomId === null) return null;
  return read !== null && read.roomId === roomId ? read.load : { kind: 'loading' };
}
