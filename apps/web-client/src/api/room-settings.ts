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

export interface DefaultExpiryImpact {
  readonly affectedCount: number;
  readonly paths: readonly string[];
  readonly resolvedExpiresAt: string | null;
  readonly confirmation: string;
  readonly message: string;
}

/**
 * Every declared field, not only the ones a caller happens to read.
 *
 * A field left unvalidated is a field the server can stop sending without anything
 * noticing, and these bodies carry what a person is about to confirm.
 */
function parseExpiryImpact(payload: unknown): DefaultExpiryImpact {
  if (!isRecord(payload)) throw new ApiError('unavailable');
  const impact = requireRecord(payload, 'impact');
  return {
    affectedCount: requireInteger(impact, 'affectedCount'),
    paths: requireArray(impact, 'paths').map((path) => {
      if (typeof path !== 'string') throw new ApiError('unavailable');
      return path;
    }),
    resolvedExpiresAt: instantOrNull(impact['resolvedExpiresAt']),
    confirmation: requireString(impact, 'confirmation'),
    message: requireString(impact, 'message'),
  };
}

/* An apply answers the room's new revision; a review does not. Requiring it separates the
   two, so a review body cannot be mistaken for evidence that something was applied. */
function parseAppliedExpiry(payload: unknown): void {
  parseExpiryImpact(payload);
  if (!isRecord(payload)) throw new ApiError('unavailable');
  requireInteger(requireRecord(payload, 'impact'), 'roomRevision');
}

export async function setRoomDownloadPolicy(
  roomId: string,
  policy: DownloadPolicy | null,
  expectedRoomRevision: number,
): Promise<void> {
  const payload = await json({
    method: 'POST',
    path: '/api/policies',
    body: { action: 'room-download', roomId, policy, expectedRoomRevision },
  });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  requireInteger(payload, 'roomRevision');
}

export async function reviewDefaultExpiry(
  roomId: string,
  expiresAt: string | null,
): Promise<DefaultExpiryImpact> {
  return parseExpiryImpact(
    await json({
      method: 'POST',
      path: '/api/policies',
      body: { action: 'default-expiry-dry-run', roomId, expiresAt },
    }),
  );
}

export async function applyDefaultExpiry(
  roomId: string,
  expiresAt: string | null,
  expectedRoomRevision: number,
  confirmation: string,
): Promise<void> {
  parseAppliedExpiry(
    await json({
      method: 'POST',
      path: '/api/policies',
      body: {
        action: 'default-expiry-apply',
        roomId,
        expiresAt,
        expectedRoomRevision,
        confirmation,
      },
    }),
  );
}

export interface RetentionImpact {
  readonly currentYears: number;
  readonly proposedYears: number;
  readonly confirmation: string;
}

export interface PurgeImpact {
  readonly documentCount: number;
  readonly viewerCount: number;
  readonly sourceBytes: number;
  readonly cancellationDays: 30;
  readonly confirmation: string;
}

/** `cancel_room_purge` compares this constant; no dry run returns it. */
export const CANCEL_PURGE_PHRASE = 'CANCEL ROOM PURGE';

async function lifecycle(
  body: Readonly<Record<string, unknown>>,
): Promise<Readonly<Record<string, unknown>>> {
  const payload = await json({ method: 'POST', path: '/api/rooms/lifecycle', body });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  return payload;
}

function parseRetention(payload: Readonly<Record<string, unknown>>): RetentionImpact {
  const impact = requireRecord(payload, 'retention');
  /* The server states this as a literal rather than a flag it computes, and the client
     repeats the promise in its copy, so a body without it is not one to act on. */
  if (impact['existingAuditRowsUnaffected'] !== true) throw new ApiError('unavailable');
  requireString(impact, 'roomId');
  return {
    currentYears: requireInteger(impact, 'currentYears'),
    proposedYears: requireInteger(impact, 'proposedYears'),
    confirmation: requireString(impact, 'confirmation'),
  };
}

function parsePurge(payload: Readonly<Record<string, unknown>>): PurgeImpact {
  const impact = requireRecord(payload, 'purge');
  if (impact['cancellationDays'] !== 30) throw new ApiError('unavailable');
  requireString(impact, 'roomId');
  return {
    documentCount: requireInteger(impact, 'documentCount'),
    viewerCount: requireInteger(impact, 'viewerCount'),
    /*
     * A byte total the server sends above 2^53 would already have lost precision in JSON, so
     * a size that cannot be represented exactly is refused rather than shown rounded: the
     * purge consequence is evidence, and an approximate one invites the wrong decision.
     */
    sourceBytes: safeByteTotal(requireInteger(impact, 'sourceBytes')),
    cancellationDays: 30,
    confirmation: requireString(impact, 'confirmation'),
  };
}

function safeByteTotal(value: number): number {
  if (!Number.isSafeInteger(value)) throw new ApiError('unavailable');
  return value;
}

/* A scheduled purge answers which purge it created and when it runs; the review does not. */
function parseScheduledPurge(payload: Readonly<Record<string, unknown>>): void {
  parsePurge(payload);
  const impact = requireRecord(payload, 'purge');
  requireString(impact, 'purgeId');
  if (instantOrNull(impact['purgeAfter']) === null) throw new ApiError('unavailable');
}

/* An applied retention answers the room's new revision. */
function parseAppliedRetention(payload: Readonly<Record<string, unknown>>): void {
  parseRetention(payload);
  requireInteger(requireRecord(payload, 'retention'), 'revision');
}

export async function reviewRetention(roomId: string, years: number): Promise<RetentionImpact> {
  return parseRetention(await lifecycle({ action: 'retention-dry-run', roomId, years }));
}

export async function applyRetention(
  roomId: string,
  years: number,
  expectedRevision: number,
  confirmation: string,
): Promise<void> {
  parseAppliedRetention(
    await lifecycle({
      action: 'retention-apply',
      roomId,
      years,
      expectedRevision,
      confirmation,
    }),
  );
}

export async function reviewPurge(roomId: string): Promise<PurgeImpact> {
  return parsePurge(await lifecycle({ action: 'purge-dry-run', roomId }));
}

export async function schedulePurge(
  roomId: string,
  expectedRevision: number,
  confirmation: string,
): Promise<void> {
  parseScheduledPurge(
    await lifecycle({ action: 'purge-schedule', roomId, expectedRevision, confirmation }),
  );
}

export async function cancelPurge(purgeId: string): Promise<void> {
  const payload = await lifecycle({
    action: 'purge-cancel',
    purgeId,
    confirmation: CANCEL_PURGE_PHRASE,
  });
  if (payload['cancelled'] !== true) throw new ApiError('unavailable');
}

export async function setDocumentDownloadPolicy(
  documentId: string,
  policy: DownloadPolicy | null,
  expectedDocumentRevision: number,
): Promise<void> {
  const payload = await json({
    method: 'POST',
    path: '/api/policies',
    body: { action: 'document-download', documentId, policy, expectedDocumentRevision },
  });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  requireInteger(payload, 'documentRevision');
}
