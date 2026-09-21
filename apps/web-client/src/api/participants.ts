/**
 * Participants and allow-only access grants.
 *
 * Split out of api/client.ts, which had grown to hold every HTTP domain in one
 * file. The transport, CSRF handling, and failure classification stay shared in
 * transport.ts so there is exactly one place that talks to the network.
 */

import {
  ApiError,
  instantOrNull,
  isRecord,
  json,
  oneOf,
  requireArray,
  requireInteger,
  requireString,
} from './transport.ts';

export type GrantSource = 'direct' | 'counterparty';
export type GrantTargetKind = 'room' | 'folder' | 'document';
export type GrantChangeAction = 'grant' | 'revoke' | 'expiry';
export type GranteeKind = 'viewer' | 'counterparty';

export interface ParticipantGrant {
  readonly grantId: string;
  readonly source: GrantSource;
  readonly targetKind: GrantTargetKind;
  readonly folderId: string | null;
  readonly documentId: string | null;
  readonly expiresAt: string | null;
  /** False for an expired or superseded grant, which is still shown. */
  readonly effective: boolean;
  readonly revision: number;
}

export interface Participant {
  readonly viewerId: string;
  readonly email: string;
  readonly membershipState: 'active' | 'revoked';
  readonly membershipRevision: number;
  readonly counterpartyId: string | null;
  readonly counterpartyName: string | null;
  readonly grants: readonly ParticipantGrant[];
}

export interface Counterparty {
  readonly counterpartyId: string;
  readonly name: string;
  readonly revision: number;
  readonly viewerCount: number;
}

export interface ParticipantRoster {
  readonly participants: readonly Participant[];
  readonly counterparties: readonly Counterparty[];
}

/** The server's impact statement. Every field is the server's, not derived. */
export interface GrantImpact {
  readonly grantId: string;
  readonly action: GrantChangeAction;
  readonly affectedCount: number;
  readonly paths: readonly string[];
  readonly confirmation: string;
  readonly message: string;
  readonly resolvedExpiresAt: string | null;
  readonly roomRevision?: number;
}

export interface GrantChangeRequest {
  readonly roomId: string;
  readonly changeAction: GrantChangeAction;
  readonly grantId?: string;
  readonly granteeKind: GranteeKind | null;
  readonly viewerId: string | null;
  readonly counterpartyId: string | null;
  readonly targetKind: GrantTargetKind | null;
  readonly folderId: string | null;
  readonly documentId: string | null;
  readonly expiresAt: string | null;
}

const SOURCES: readonly GrantSource[] = ['direct', 'counterparty'];
const TARGET_KINDS: readonly GrantTargetKind[] = ['room', 'folder', 'document'];
const MEMBERSHIP_STATES: readonly Participant['membershipState'][] = ['active', 'revoked'];

function stringOrNull(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new ApiError('unavailable');
  return value;
}

function positive(value: Readonly<Record<string, unknown>>, key: string): number {
  const revision = requireInteger(value, key);
  if (revision < 1) throw new ApiError('unavailable');
  return revision;
}

/**
 * Who can read what, as the server reported it.
 *
 * Parsed field by field rather than cast, because this is the answer a Room Manager reads
 * access off: a grant whose `effective` flag arrived as a string, or a target kind this client
 * does not know, must fail closed rather than be rendered as authoritative access.
 */
function parseGrant(value: unknown): ParticipantGrant {
  if (!isRecord(value)) throw new ApiError('unavailable');
  if (typeof value['effective'] !== 'boolean') throw new ApiError('unavailable');
  return {
    grantId: requireString(value, 'grantId'),
    source: oneOf(SOURCES, value['source']),
    targetKind: oneOf(TARGET_KINDS, value['targetKind']),
    folderId: stringOrNull(value['folderId']),
    documentId: stringOrNull(value['documentId']),
    expiresAt: instantOrNull(value['expiresAt']),
    effective: value['effective'],
    revision: positive(value, 'revision'),
  };
}

function parseParticipant(value: unknown): Participant {
  if (!isRecord(value)) throw new ApiError('unavailable');
  const counterpartyId = stringOrNull(value['counterpartyId']);
  const counterpartyName = stringOrNull(value['counterpartyName']);
  /* A placement is an id AND a name, so one without the other is a body to refuse rather than
     a reader shown as belonging to a counterparty nobody can name. */
  if ((counterpartyId === null) !== (counterpartyName === null))
    throw new ApiError('unavailable');
  return {
    viewerId: requireString(value, 'viewerId'),
    email: requireString(value, 'email'),
    membershipState: oneOf(MEMBERSHIP_STATES, value['membershipState']),
    membershipRevision: positive(value, 'membershipRevision'),
    counterpartyId,
    counterpartyName,
    grants: requireArray(value, 'grants').map(parseGrant),
  };
}

function parseCounterparty(value: unknown): Counterparty {
  if (!isRecord(value)) throw new ApiError('unavailable');
  const viewerCount = requireInteger(value, 'viewerCount');
  if (viewerCount < 0) throw new ApiError('unavailable');
  const revision = requireInteger(value, 'revision');
  if (revision < 1) throw new ApiError('unavailable');
  return {
    counterpartyId: requireString(value, 'counterpartyId'),
    name: requireString(value, 'name'),
    revision,
    viewerCount,
  };
}

export async function loadParticipants(
  roomId: string,
  signal?: AbortSignal,
): Promise<ParticipantRoster> {
  const payload = await json({
    method: 'GET',
    path: `/api/participants?roomId=${encodeURIComponent(roomId)}`,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  return {
    participants: requireArray(payload, 'participants').map(parseParticipant),
    counterparties: requireArray(payload, 'counterparties').map(parseCounterparty),
  };
}

async function counterpartyAction(body: Readonly<Record<string, unknown>>): Promise<void> {
  const payload = await json({ method: 'POST', path: '/api/counterparties', body });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  /* A revision starts at 1 and only advances, so a zero or negative one is not a room this
     client can hold an expectation against. */
  positive(payload, 'roomRevision');
}

export function createCounterparty(input: {
  readonly roomId: string;
  readonly name: string;
  readonly expectedRoomRevision: number;
}): Promise<void> {
  return counterpartyAction({ action: 'create', ...input, name: input.name.normalize('NFC') });
}

export function placeViewerInCounterparty(input: {
  readonly roomId: string;
  readonly counterpartyId: string;
  readonly viewerId: string;
  readonly expectedRoomRevision: number;
}): Promise<void> {
  return counterpartyAction({ action: 'assign-viewer', ...input });
}

export function removeViewerFromCounterparty(input: {
  readonly roomId: string;
  readonly viewerId: string;
  readonly expectedRoomRevision: number;
}): Promise<void> {
  return counterpartyAction({ action: 'remove-viewer', ...input });
}

export async function inviteParticipant(input: {
  readonly roomId: string;
  readonly email: string;
  readonly expectedRoomRevision: number;
}): Promise<{ readonly invitationId: string; readonly roomRevision: number }> {
  const payload = await json({
    method: 'POST',
    path: '/api/participants/invitations',
    body: input,
  });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  return {
    invitationId: requireString(payload, 'invitationId'),
    roomRevision: requireInteger(payload, 'roomRevision'),
  };
}

/**
 * Parses a grant impact STRICTLY.
 *
 * A count without its paths, or a missing confirmation phrase, would render a
 * confident "this affects N documents" that the apply path might not honour.
 * That is the false-confirmation failure the preview exists to prevent, so an
 * inconsistent payload surfaces as unavailable instead of as reassurance.
 */
function parseGrantImpact(payload: unknown): GrantImpact {
  if (!isRecord(payload)) throw new ApiError('unavailable');
  const action = payload['action'];
  if (action !== 'grant' && action !== 'revoke' && action !== 'expiry')
    throw new ApiError('unavailable');
  const rawPaths = payload['paths'];
  if (!Array.isArray(rawPaths) || !rawPaths.every((value) => typeof value === 'string'))
    throw new ApiError('unavailable');
  const expires = payload['resolvedExpiresAt'];
  if (expires !== null && typeof expires !== 'string') throw new ApiError('unavailable');
  const revision = payload['roomRevision'];
  if (
    revision !== undefined &&
    (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1)
  )
    throw new ApiError('unavailable');
  return {
    grantId: requireString(payload, 'grantId'),
    action,
    affectedCount: requireInteger(payload, 'affectedCount'),
    paths: rawPaths,
    confirmation: requireString(payload, 'confirmation'),
    message: requireString(payload, 'message'),
    resolvedExpiresAt: expires,
    ...(revision === undefined ? {} : { roomRevision: revision }),
  };
}

export async function dryRunGrantChange(input: GrantChangeRequest): Promise<GrantImpact> {
  return parseGrantImpact(
    await json({ method: 'POST', path: '/api/grants', body: { action: 'dry-run', ...input } }),
  );
}

/**
 * Applies a grant change. `grantId` and `confirmation` MUST be the values the
 * dry-run returned: the server re-runs the impact and compares both, so a caller
 * that skipped the preview cannot guess them.
 */
export async function applyGrantChange(
  input: GrantChangeRequest & {
    readonly grantId: string;
    readonly expectedRoomRevision: number;
    readonly confirmation: string;
  },
): Promise<GrantImpact> {
  return parseGrantImpact(
    await json({ method: 'POST', path: '/api/grants', body: { action: 'apply', ...input } }),
  );
}
