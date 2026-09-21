/** Pure derivations for the Settings section, kept testable without a DOM. */
import type { DocumentEntry, DownloadPolicy, RoomSettings } from '../api/client.ts';
import type { PresentedFailure } from './failures.ts';
import { expiryInstant, formatDate } from './grants.ts';
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

/**
 * The default-expiry field: empty means no default, a date means the end of that UTC day,
 * anything else is not reviewable. Never collapses an unreadable date into "no default".
 */
/**
 * The field's date as the instant the server will store, or a refusal.
 *
 * An empty field means "no default", which is a value and not a mistake. A date that does
 * not exist is refused rather than normalized: `new Date` turns 31 February into 3 March,
 * and silently storing a different day than the one chosen is worse than saying no. The
 * instant must also still be ahead, because the server refuses a past one with a 400 and a
 * refusal the browser could have explained beside the field is a worse experience.
 */
export function parseExpiryField(
  value: string,
  now: Date = new Date(),
): { readonly ok: true; readonly expiresAt: string | null } | { readonly ok: false } {
  if (value === '') return { ok: true, expiresAt: null };
  const instant = expiryInstant(value);
  if (instant === null) return { ok: false };
  if (instant.toISOString().slice(0, 10) !== value) return { ok: false };
  if (instant.getTime() <= now.getTime()) return { ok: false };
  return { ok: true, expiresAt: instant.toISOString() };
}

/**
 * §9.2: localized time, with the exact UTC instant beside it.
 *
 * Seconds are part of the value, not decoration: an expiry is the end of the chosen day, so
 * truncating to the minute would show 23:59 for an instant that is 23:59:59.999 and the
 * "exact inherited value" the review promises would not be the one displayed.
 */
export function expiryDisplay(instant: string): {
  readonly local: string;
  readonly utc: string;
} {
  const iso = new Date(instant).toISOString();
  return { local: formatDate(instant), utc: `${iso.slice(0, 19).replace('T', ' ')} UTC` };
}

const BYTE_UNITS = ['B', 'kB', 'MB', 'GB', 'TB'] as const;

/** Decimal units, one significant decimal above bytes. */
export function formatByteSize(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

/** What the collection needs to show and change per-document download exceptions. */
export interface StructureDownloads {
  readonly overrides: ReadonlyMap<string, DownloadPolicy>;
  /** What a document without its own policy resolves to. */
  readonly inherited: DownloadPolicy;
  readonly change: (
    entry: DocumentEntry,
    policy: DownloadPolicy | null,
  ) => Promise<PresentedFailure | null>;
  readonly reload: () => void;
}
