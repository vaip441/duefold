/**
 * Room settings, visibility, policy, and lifecycle calls.
 *
 * Every response is parsed field by field and a value this client does not recognize
 * fails closed: capabilities decide which controls appear, so an unparsed capability
 * would be a control the server never offered.
 */
import type { RoomState } from './rooms.ts';
import {
  ApiError,
  isRecord,
  json,
  requireArray,
  requireInteger,
  requireString,
} from './transport.ts';

export type DownloadPolicy = 'allow' | 'deny';
export type ReviewedVisibility = 'published' | 'archived';
export type PurgeState = 'scheduled' | 'marker_pending' | 'purging' | 'purged' | 'failed';

export interface RoomCapabilities {
  readonly publish: boolean;
  readonly archive: boolean;
  readonly returnToDraft: boolean;
  readonly setRetention: boolean;
  readonly schedulePurge: boolean;
  readonly cancelPurge: boolean;
}

export interface RoomSettings {
  readonly roomId: string;
  readonly state: RoomState;
  readonly revision: number;
  readonly publishedRevision: number;
  readonly auditRetentionYears: number;
  readonly defaultGrantExpiresAt: string | null;
  readonly downloadPolicy: DownloadPolicy | null;
  readonly installationDownloadPolicy: DownloadPolicy;
  readonly purge: {
    readonly purgeId: string;
    readonly state: PurgeState;
    readonly purgeAfter: string;
  } | null;
  readonly capabilities: RoomCapabilities;
}

export interface RoomSettingsView {
  readonly settings: RoomSettings;
  readonly downloadOverrides: ReadonlyMap<string, DownloadPolicy>;
}

export interface VisibilityImpact {
  readonly roomId: string;
  readonly currentState: RoomState;
  readonly proposedState: ReviewedVisibility;
  readonly viewerCount: number;
  readonly publishedDocumentCount: number;
  readonly requiresFreshAuthentication: boolean;
  readonly expectedRevision: number;
  readonly confirmation: string;
}

export type VisibilityChange =
  | { readonly state: 'draft'; readonly expectedRevision: number }
  | {
      readonly state: ReviewedVisibility;
      readonly expectedRevision: number;
      readonly confirmation: string;
    };

const STATES: readonly RoomState[] = ['draft', 'published', 'archived'];
const POLICIES: readonly DownloadPolicy[] = ['allow', 'deny'];
const PURGE_STATES: readonly PurgeState[] = [
  'scheduled',
  'marker_pending',
  'purging',
  'purged',
  'failed',
];
const REVIEWED: readonly ReviewedVisibility[] = ['published', 'archived'];

export function oneOf<T>(values: readonly T[], value: unknown): T {
  if (!(values as readonly unknown[]).includes(value)) throw new ApiError('unavailable');
  return value as T;
}

export function instantOrNull(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)))
    throw new ApiError('unavailable');
  return value;
}

export function requireRecord(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> {
  const nested = value[key];
  if (!isRecord(nested)) throw new ApiError('unavailable');
  return nested;
}

export function requireBoolean(value: Readonly<Record<string, unknown>>, key: string): boolean {
  const flag = value[key];
  if (typeof flag !== 'boolean') throw new ApiError('unavailable');
  return flag;
}

function parseSettings(value: Readonly<Record<string, unknown>>): RoomSettings {
  const capabilities = requireRecord(value, 'capabilities');
  const purge = value['purge'];
  return {
    roomId: requireString(value, 'roomId'),
    state: oneOf(STATES, value['state']),
    revision: requireInteger(value, 'revision'),
    publishedRevision: requireInteger(value, 'publishedRevision'),
    auditRetentionYears: requireInteger(value, 'auditRetentionYears'),
    defaultGrantExpiresAt: instantOrNull(value['defaultGrantExpiresAt']),
    downloadPolicy:
      value['downloadPolicy'] === null ? null : oneOf(POLICIES, value['downloadPolicy']),
    installationDownloadPolicy: oneOf(POLICIES, value['installationDownloadPolicy']),
    purge:
      purge === null
        ? null
        : (() => {
            if (!isRecord(purge)) throw new ApiError('unavailable');
            const purgeAfter = instantOrNull(purge['purgeAfter']);
            if (purgeAfter === null) throw new ApiError('unavailable');
            return {
              purgeId: requireString(purge, 'purgeId'),
              state: oneOf(PURGE_STATES, purge['state']),
              purgeAfter,
            };
          })(),
    capabilities: {
      publish: requireBoolean(capabilities, 'publish'),
      archive: requireBoolean(capabilities, 'archive'),
      returnToDraft: requireBoolean(capabilities, 'returnToDraft'),
      setRetention: requireBoolean(capabilities, 'setRetention'),
      schedulePurge: requireBoolean(capabilities, 'schedulePurge'),
      cancelPurge: requireBoolean(capabilities, 'cancelPurge'),
    },
  };
}

export async function loadRoomSettings(
  roomId: string,
  signal?: AbortSignal,
): Promise<RoomSettingsView> {
  const payload = await json({
    method: 'GET',
    path: `/api/rooms/settings?roomId=${encodeURIComponent(roomId)}`,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  const overrides = requireArray(payload, 'downloadOverrides').map((entry) => {
    if (!isRecord(entry)) throw new ApiError('unavailable');
    return [requireString(entry, 'documentId'), oneOf(POLICIES, entry['policy'])] as const;
  });
  /* A document has one policy, so two rows naming the same document are contradictory. A Map
     would silently keep the last, which is a guess about which answer was meant. */
  if (new Set(overrides.map(([documentId]) => documentId)).size !== overrides.length)
    throw new ApiError('unavailable');
  return {
    settings: parseSettings(requireRecord(payload, 'settings')),
    downloadOverrides: new Map(overrides),
  };
}

export async function reviewVisibility(
  roomId: string,
  state: ReviewedVisibility,
): Promise<VisibilityImpact> {
  const payload = await json({
    method: 'POST',
    path: '/api/rooms/visibility',
    body: { action: 'dry-run', roomId, state },
  });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  const impact = requireRecord(payload, 'impact');
  return {
    roomId: requireString(impact, 'roomId'),
    currentState: oneOf(STATES, impact['currentState']),
    proposedState: oneOf(REVIEWED, impact['proposedState']),
    viewerCount: requireInteger(impact, 'viewerCount'),
    publishedDocumentCount: requireInteger(impact, 'publishedDocumentCount'),
    requiresFreshAuthentication: requireBoolean(impact, 'requiresFreshAuthentication'),
    expectedRevision: requireInteger(impact, 'expectedRevision'),
    confirmation: requireString(impact, 'confirmation'),
  };
}

export async function applyVisibility(roomId: string, change: VisibilityChange): Promise<void> {
  const payload = await json({
    method: 'POST',
    path: '/api/rooms/visibility',
    body: { action: 'apply', roomId, ...change },
  });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  requireInteger(payload, 'revision');
}
